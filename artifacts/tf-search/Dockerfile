FROM docker.io/library/node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./

RUN node -e " \
  const fs = require('fs'); \
  const workspace = fs.readFileSync('pnpm-workspace.yaml', 'utf8'); \
  const narrowed = workspace.replace(/^packages:[\\s\\S]*?(?=\\n[a-zA-Z])/m, \
    'packages:\\n  - artifacts/tf-search\\n  - lib/module-runtime-contract\\n  - lib/tf-search-contract\\n\\n'); \
  fs.writeFileSync('pnpm-workspace.yaml', narrowed);"

COPY lib/module-runtime-contract/package.json ./lib/module-runtime-contract/
COPY lib/tf-search-contract/package.json ./lib/tf-search-contract/
COPY artifacts/tf-search/package.json ./artifacts/tf-search/
COPY lib/module-runtime-contract ./lib/module-runtime-contract
COPY lib/tf-search-contract ./lib/tf-search-contract
COPY artifacts/tf-search ./artifacts/tf-search

RUN pnpm install --frozen-lockfile --filter @workspace/tf-search... \
  && pnpm --filter @workspace/tf-search run build

FROM docker.io/library/node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runner

ARG YT_DLP_VERSION=2026.7.4
ARG YT_DLP_SHA256=f11f2b11d5a8ac4059f9bdf29fa4407dc7c6bb00c5097e95ca22a7a9db518266

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
  && printf '%s\n' "yt-dlp==${YT_DLP_VERSION} --hash=sha256:${YT_DLP_SHA256}" > /tmp/requirements.txt \
  && python3 -m pip install --no-cache-dir --break-system-packages --require-hashes -r /tmp/requirements.txt \
  && rm /tmp/requirements.txt \
  && apt-get clean && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 tf-search \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin tf-search

WORKDIR /app

COPY --from=builder /app/artifacts/tf-search/dist ./dist
COPY artifacts/tf-search/container/start-search.sh ./bin/start-search.sh

RUN chmod 0555 /app/bin/start-search.sh \
  && chmod -R a-w /app

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

USER 10001:10001
ENTRYPOINT ["/app/bin/start-search.sh"]
CMD ["node", "/app/dist/index.mjs"]
