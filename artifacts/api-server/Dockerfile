FROM node:20-slim AS builder

WORKDIR /app

RUN npm install -g pnpm

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./

RUN node -e " \
  const fs = require('fs'); \
  const y = fs.readFileSync('pnpm-workspace.yaml', 'utf8'); \
  const replaced = y.replace(/^packages:[\s\S]*?(?=\n[a-zA-Z])/m, \
    'packages:\n  - artifacts/api-server\n  - lib/db\n  - lib/api-zod\n\n'); \
  fs.writeFileSync('pnpm-workspace.yaml', replaced);"

COPY lib/db/package.json ./lib/db/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY artifacts/api-server/package.json ./artifacts/api-server/

RUN pnpm install --frozen-lockfile

COPY lib/db ./lib/db
COPY lib/api-zod ./lib/api-zod
COPY artifacts/api-server ./artifacts/api-server

RUN pnpm --filter @workspace/api-server run build

FROM node:20-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./dist

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.mjs"]
