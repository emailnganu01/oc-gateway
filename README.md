# opencode-gateway

Gateway ringan khusus opencode — meneruskan request format OpenAI ke free tier opencode.ai (`https://opencode.ai/zen/v1`), dengan kontrak request yang sama persis dengan yang dipakai 9router (`open-sse/executors/opencode.js`), tapi **tanpa Next.js, tanpa database, tanpa dependency sama sekali**.

## Kenapa ada

9router itu app besar (Next.js + SQLite + 40+ provider). Kalau kamu cuma butuh `opencode` → `deepseek-v4-flash-free`, gateway ini jauh lebih ringan:

| | 9router | opencode-gateway |
|---|---|---|
| Dependency | banyak (Next, express, dsb.) | **0** (Node ≥ 18, `fetch` bawaan) |
| RAM | ~300–500 MB | < 50 MB |
| Deploy | build Next.js | 1 file `server.js` |
| Endpoint | `/v1/*` + dashboard | `/v1/chat/completions` + `/v1/models` |

## Cara kerja

```
opencode CLI ──POST /v1/chat/completions──▶ gateway ──▶ opencode.ai/zen/v1/chat/completions
        ◀────── SSE stream ◀──────────────────────◀──── (Authorization: Bearer public + x-opencode-*)
```

Header upstream (sama seperti 9router):
- `Authorization: Bearer public`
- `User-Agent: opencode` (atau UA client asli jika mengandung "opencode")
- `x-opencode-client: desktop` (bisa di-override client)
- `x-opencode-session` — lihat `SESSION_MODE`
- `x-opencode-request: msg_<uuid>`
- `x-opencode-project: global`

Plus `reasoning_content` injection untuk model thinking (DeepSeek/Kimi/MiniMax), diambil dari `open-sse/utils/reasoningContentInjector.js`.

## Endpoint

| Method | Path | Keterangan |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI format → zen (SSE passthrough) |
| GET | `/v1/models` | Daftar model (difilter `*-free` + alias) |
| GET | `/health` | Liveness |

## Alias model

Panggil model cukup dengan alias — tidak perlu mengetik nama panjang:

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "telur-ceplok", "messages": [{"role": "user", "content": "hi"}]}'
```

| Alias | Model asli |
|---|---|
| `telur-ceplok` | `deepseek-v4-flash-free` |

Alias default ada di `server.js` (`DEFAULT_ALIASES`). Tambah sendiri via env `MODEL_ALIASES` (JSON, override default):

```bash
MODEL_ALIASES={"telur-ceplok":"deepseek-v4-flash-free","mimo":"mimo-v2.5-free"}
```

Alias juga muncul di `/v1/models`, jadi bisa dipilih dari model picker client.

## Deploy ke Railway

```bash
# 1. buat repo git baru (atau subfolder ini saja)
cd opencode-gateway
git init && git add . && git commit -m "opencode gateway"
git remote add origin https://github.com/<kamu>/opencode-gateway.git
git push -u origin main
```

```bash
# 2. Railway → New Project → Deploy from GitHub repo → pilih repo
```

```bash
# 3. Variables (opsional)
GATEWAY_KEY=   # proteksi endpoint bila diisi
SESSION_MODE=fresh
```

Railway auto-detect port dari `PORT` env. Selesai — domain jadi `https://xxx.up.railway.app`.

## Konfigurasi opencode CLI

```jsonc
// opencode.json (di folder proyekmu)
{
  "provider": {
    "9router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "9router Gateway",
      "options": {
        "baseURL": "https://xxx.up.railway.app/v1",
        "apiKey": "sk-anything"   // diabaikan kecuali GATEWAY_KEY diset
      },
      "models": {
        "deepseek-v4-flash-free": { "name": "DeepSeek V4 Flash Free" }
      }
    }
  }
}
```

Atau set via env:

```bash
export OPENCODE_PROVIDER=9router
export OPENCODE_MODEL=deepseek-v4-flash-free
```

## SESSION_MODE — kenapa penting

Dari pembahasan sebelumnya, limit `FreeUsageLimitError` (429) dari opencode.ai **tidak hilang walau ganti IP** — indikasi limit dihitung per `x-opencode-session`. 9router memakai **satu session** untuk semua request provider no-auth (connectionId `"noauth"`), jadi semua requestmu berbagi satu kuota.

Gateway ini memberi 3 mode:

| Mode | Perilaku | Cocok untuk |
|---|---|---|
| `fresh` (default) | `ses_` baru tiap request | Menghindari limit per-session, kuota maksimal |
| `stable` | hash pesan user pertama → `ses_` sama per percakapan | Prompt-cache upstream, kontinuitas percakapan |
| `client` | pakai `x-opencode-session` client bila ada | Meniru perilaku 9router/CLI asli |

Kalau 429 masih muncul di mode `fresh`, itu berarti limit bukan per-session — kemungkinan global/akun, dan gateway tidak bisa menolong.

## Opsional: auth

Set `GATEWAY_KEY=rahasia` di Railway, lalu semua request wajib:

```
Authorization: Bearer rahasia
```

Sebaiknya aktifkan — endpoint-mu di internet terbuka untuk dipakai siapa saja yang tahu URL-nya (free tier opencode.ai "Bearer public" tidak butuh akun).

## Catatan fair-use

- `Bearer public` adalah akses free tier opencode.ai yang di-reverse-engineer (seperti 9router). Bisa berubah/berhenti kapan saja.
- Free tier punya kuota — session baru memberi kuota baru, tapi tetap ada batas global.
- Untuk akses stabil berbayar: opencode-go (subscription) punya `deepseek-v4-flash` resmi, atau pakai DeepSeek API langsung.
