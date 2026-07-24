FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./

RUN node -e " \
  const fs = require('fs'); \
  const y = fs.readFileSync('pnpm-workspace.yaml', 'utf8'); \
  const replaced = y.replace(/^packages:[\s\S]*?(?=\n[a-zA-Z])/m, \
    'packages:\n  - artifacts/api-server\n  - lib/admin-dashboard-contract\n  - lib/db\n  - lib/api-zod\n  - lib/module-runtime-contract\n  - lib/platform-contract\n  - lib/tf-search-contract\n\n'); \
  fs.writeFileSync('pnpm-workspace.yaml', replaced);"

COPY lib/db/package.json ./lib/db/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/admin-dashboard-contract/package.json ./lib/admin-dashboard-contract/
COPY lib/module-runtime-contract/package.json ./lib/module-runtime-contract/
COPY lib/platform-contract/package.json ./lib/platform-contract/
COPY lib/tf-search-contract/package.json ./lib/tf-search-contract/
COPY artifacts/api-server/package.json ./artifacts/api-server/

COPY lib/db ./lib/db
COPY lib/api-zod ./lib/api-zod
COPY lib/admin-dashboard-contract ./lib/admin-dashboard-contract
COPY lib/module-runtime-contract ./lib/module-runtime-contract
COPY lib/platform-contract ./lib/platform-contract
COPY lib/tf-search-contract ./lib/tf-search-contract
COPY artifacts/api-server ./artifacts/api-server

RUN pnpm install --frozen-lockfile --filter @workspace/api-server...

RUN pnpm --filter @workspace/api-server run build

FROM node:20-bookworm-slim AS runner

ARG YT_DLP_VERSION=2026.7.4
ARG YT_DLP_SHA256=f11f2b11d5a8ac4059f9bdf29fa4407dc7c6bb00c5097e95ca22a7a9db518266

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg \
  && printf '%s\n' "yt-dlp==${YT_DLP_VERSION} --hash=sha256:${YT_DLP_SHA256}" > /tmp/requirements.txt \
  && python3 -m pip install --no-cache-dir --break-system-packages --require-hashes -r /tmp/requirements.txt \
  && rm /tmp/requirements.txt \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 apollo \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin apollo

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY artifacts/api-server/container/start-tf.sh ./bin/start-tf.sh

RUN chmod 0555 /app/bin/start-tf.sh \
  && chmod -R a-w /app

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

USER 10001:10001
ENTRYPOINT ["/app/bin/start-tf.sh"]
CMD ["node", "artifacts/api-server/dist/index.mjs"]
