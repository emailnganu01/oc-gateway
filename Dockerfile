# opencode-gateway — minimal container. Zero deps, Node runtime only.
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0

COPY package.json ./
COPY server.js ./

# Tidak perlu npm install — tidak ada dependencies.
EXPOSE 20128

CMD ["node", "server.js"]
