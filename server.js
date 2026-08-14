/**
 * opencode-gateway — lightweight opencode-only gateway
 * ----------------------------------------------------
 * Proxy "opencode free" (https://opencode.ai/zen/v1) with the same request
 * contract 9router uses (open-sse/executors/opencode.js), minus the whole
 * Next.js app. Zero dependencies — plain Node >= 18 (global fetch).
 *
 * Endpoints:
 *   POST /v1/chat/completions   OpenAI format → opencode.ai zen (SSE passthrough)
 *   GET  /v1/models             Model list (filtered to free models)
 *   GET  /health                Liveness check
 *
 * Env vars (all optional, see .env.example):
 *   PORT          listen port (default 20128; Railway sets PORT itself)
 *   GATEWAY_KEY   if set, require `Authorization: Bearer <key>` on every request
 *   SESSION_MODE  fresh (default) | stable | client
 *   FORWARD_UA    "keep" (default) | "opencode" — pass through opencode client UA or force it
 */

"use strict";

const http = require("http");
const crypto = require("crypto");

const UPSTREAM = "https://opencode.ai/zen/v1";
const PORT = Number(process.env.PORT || 20128);
const GATEWAY_KEY = (process.env.GATEWAY_KEY || "").trim();
const SESSION_MODE = (process.env.SESSION_MODE || "fresh").trim().toLowerCase();
const FORWARD_UA = (process.env.FORWARD_UA || "keep").trim().toLowerCase();

// ─── model aliases ────────────────────────────────────────────────────────────
// Panggil model cukup pakai alias, mis. "ds4f" → "deepseek-v4-flash-free".
// Tambah alias sendiri via env MODEL_ALIASES (JSON), contoh:
//   MODEL_ALIASES={"ds4f":"deepseek-v4-flash-free","mimo":"mimo-v2.5-free"}
const DEFAULT_ALIASES = {
  ds4f: "deepseek-v4-flash-free",
};
function loadAliases() {
  try {
    return { ...DEFAULT_ALIASES, ...JSON.parse(process.env.MODEL_ALIASES || "{}") };
  } catch {
    return DEFAULT_ALIASES;
  }
}
const ALIASES = loadAliases();

// ─── helpers (mirror open-sse/executors/opencode.js) ─────────────────────────

const genUuid = () => crypto.randomUUID().replace(/-/g, "");

function generateRequestId() {
  return `msg_${genUuid()}`;
}

function generateSessionId() {
  return `ses_${genUuid()}`;
}

// Normalize any resolved id into opencode's ses_ format
function toOpencodeSession(id) {
  const stripped = String(id || "").replace(/^ses_/, "").replace(/-/g, "");
  return stripped ? `ses_${stripped}` : null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 50e6) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function lowerHeaderMap(req) {
  const lower = {};
  for (const [k, v] of Object.entries(req.headers)) lower[k.toLowerCase()] = v;
  return lower;
}

// ─── session resolution (mirror open-sse/utils/sessionManager.js intent) ─────

/**
 * SESSION_MODE:
 *  - fresh:  new ses_ per request (best for dodging per-session rate limits)
 *  - stable: hash of first user message → same session per conversation (keeps prompt-cache)
 *  - client: always take x-opencode-session from the client if present, else fresh
 */
function resolveSession(lower, body) {
  const client = lower["x-opencode-session"];
  if (SESSION_MODE === "client" && client) return String(client);

  if (SESSION_MODE === "stable") {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    const first = msgs.find((m) => m.role === "user");
    const text =
      typeof first?.content === "string" ? first.content.slice(0, 200) :
      (body?.model || "") + JSON.stringify(body?.messages || []).slice(0, 100);
    return toOpencodeSession("ses_" + crypto.createHash("sha256").update(text).digest("hex")) || generateSessionId();
  }

  return generateSessionId(); // fresh
}

// ─── reasoning content injection (mirror open-sse/utils/reasoningContentInjector.js) ──

const PLACEHOLDER = " ";

function shouldInject(msg) {
  if (msg?.role !== "assistant") return false;
  const rc = msg.reasoning_content;
  if (typeof rc === "string" && rc.length > 0) return false;
  return true;
}

// Some thinking-mode upstreams (DeepSeek/Kimi/MiniMax) require reasoning_content
// echoed back on assistant messages; OpenAI-format clients don't send it.
function injectReasoning(body) {
  if (!Array.isArray(body?.messages)) return body;
  const messages = body.messages.map((m) =>
    shouldInject(m) ? { ...m, reasoning_content: PLACEHOLDER } : m
  );
  return { ...body, messages };
}

// ─── upstream calls ──────────────────────────────────────────────────────────

async function fetchModels() {
  const res = await fetch(`${UPSTREAM}/models`, {
    headers: { Authorization: "Bearer public" },
  });
  if (!res.ok) throw new Error(`upstream /models → ${res.status}`);
  const data = await res.json();
  // Mirror src/app/api/providers/suggested-models/filters.js "opencode-free"
  const models = (data?.data || data || []).filter(
    (m) => String(m.id || m.name || "").endsWith("-free")
  );
  // Sertakan alias di daftar model supaya client bisa memilihnya
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (!models.some((m) => String(m.id || "") === alias)) {
      models.push({ id: alias, object: "model", owned_by: "alias", alias_of: target });
    }
  }
  return { ...data, data: models };
}

async function chatCompletions(body, lower) {
  // Resolve model alias (ds4f → deepseek-v4-flash-free) sebelum dikirim upstream
  if (body?.model && ALIASES[body.model]) {
    body.model = ALIASES[body.model];
  }

  const downstreamUa = String(lower["user-agent"] || "");
  const isOpencodeDownstream = downstreamUa.toLowerCase().includes("opencode");
  const ua = FORWARD_UA === "opencode" ? "opencode" : (isOpencodeDownstream ? downstreamUa : "opencode");

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer public",
    "User-Agent": ua,
    "x-opencode-client": lower["x-opencode-client"] || "desktop",
    "x-opencode-session": resolveSession(lower, body),
    "x-opencode-request": lower["x-opencode-request"] || generateRequestId(),
    "x-opencode-project": lower["x-opencode-project"] || "global",
    Accept: "text/event-stream",
  };

  const upstreamBody = injectReasoning(body);
  return fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
  });
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const lower = lowerHeaderMap(req);

  // Optional simple auth
  if (GATEWAY_KEY) {
    const ok =
      (lower["authorization"] || "") === `Bearer ${GATEWAY_KEY}` ||
      (lower["x-api-key"] || "") === GATEWAY_KEY;
    if (!ok) return sendJson(res, 401, { error: "GATEWAY_KEY required" });
  }

  // Liveness
  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return sendJson(res, 200, { ok: true, service: "opencode-gateway" });
  }

  // Model list
  if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
    try {
      const data = await fetchModels();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(data));
    } catch (e) {
      return sendJson(res, 502, { error: String(e?.message || e) });
    }
  }

  // Chat completions (streaming passthrough)
  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    let body;
    try { body = await readJson(req); } catch {
      return sendJson(res, 400, { error: "invalid JSON body" });
    }

    try {
      const up = await chatCompletions(body, lower);
      res.writeHead(up.status, {
        "content-type": up.headers.get("content-type") || "application/json",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      });

      // Stream upstream SSE back to client
      const reader = up.body.getReader();
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
      };
      pump().catch((e) => { console.error("[stream]", e?.message || e); res.end(); });
    } catch (e) {
      console.error("[upstream]", e?.message || e);
      return sendJson(res, 502, { error: String(e?.message || e) });
    }
    return;
  }

  return sendJson(res, 404, { error: "not found" });
}

http.createServer(handle).listen(PORT, "0.0.0.0", () => {
  console.log(`opencode-gateway listening on :${PORT} (session=${SESSION_MODE}${GATEWAY_KEY ? ", auth=on" : ""})`);
});