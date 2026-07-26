FROM redis:7-bookworm AS queue-redis

COPY artifacts/tf-download-worker/container/start-queue-redis.sh /usr/local/bin/start-queue-redis.sh
COPY artifacts/tf-download-worker/container/queue-redis-health.sh /usr/local/bin/queue-redis-health.sh

RUN chmod 0555 /usr/local/bin/start-queue-redis.sh \
  /usr/local/bin/queue-redis-health.sh

USER 999:999
ENTRYPOINT ["/usr/local/bin/start-queue-redis.sh"]

FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY lib/module-runtime-contract/package.json ./lib/module-runtime-contract/package.json
COPY lib/tf-download-contract/package.json ./lib/tf-download-contract/package.json
COPY artifacts/tf-download-worker/package.json ./artifacts/tf-download-worker/package.json

RUN pnpm install --frozen-lockfile --filter @workspace/tf-download-worker...

COPY lib/module-runtime-contract ./lib/module-runtime-contract
COPY lib/tf-download-contract ./lib/tf-download-contract
COPY artifacts/tf-download-worker ./artifacts/tf-download-worker

RUN pnpm --dir artifacts/tf-download-worker build

FROM node:20-bookworm-slim AS runtime

ARG YT_DLP_VERSION=2026.7.4
ARG YT_DLP_SHA256=f11f2b11d5a8ac4059f9bdf29fa4407dc7c6bb00c5097e95ca22a7a9db518266

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
  && printf '%s\n' "yt-dlp==${YT_DLP_VERSION} --hash=sha256:${YT_DLP_SHA256}" > /tmp/requirements.txt \
  && python3 -m pip install --no-cache-dir --break-system-packages --require-hashes -r /tmp/requirements.txt \
  && rm -f /tmp/requirements.txt \
  && groupadd --gid 10001 tf-download-worker \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin tf-download-worker \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
    /var/cache/apt/* \
    /usr/lib/python3/dist-packages/pip* \
    /usr/local/lib/python*/site-packages/pip* \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /var/lib/dpkg \
  && rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/apt-cache /usr/bin/apt-config \
    /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query \
    /usr/bin/pip /usr/bin/pip3 \
    /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/bin/pnpm /usr/local/bin/pnpx \
  && test ! -e /usr/bin/apt-get \
  && test ! -e /usr/bin/dpkg \
  && test ! -e /usr/bin/pip \
  && test ! -e /usr/local/bin/pip \
  && test ! -e /usr/local/bin/npm \
  && test ! -e /usr/local/bin/yarn

WORKDIR /app

COPY --from=builder /workspace/artifacts/tf-download-worker/dist ./dist
COPY artifacts/tf-download-worker/container/start-worker.sh ./bin/start-worker.sh

RUN mkdir -p /var/lib/apollo-tf/downloads \
  && chown -R 10001:10001 /var/lib/apollo-tf/downloads \
  && chmod 0700 /var/lib/apollo-tf/downloads \
  && chmod 0555 /app/bin/start-worker.sh \
  && chmod -R a-w /app

ENV NODE_ENV=production
ENV PORT=8080
ENV TF_DOWNLOAD_STORAGE_ROOT=/var/lib/apollo-tf/downloads
ENV TF_DOWNLOAD_YT_DLP_PATH=/usr/local/bin/yt-dlp

EXPOSE 8080

USER 10001:10001
ENTRYPOINT ["/app/bin/start-worker.sh"]
CMD ["node", "/app/dist/index.mjs"]

FROM runtime AS smoke-runtime

USER root
COPY artifacts/tf-download-worker/scripts/start-smoke-worker.sh ./bin/start-smoke-worker.sh
COPY artifacts/tf-download-worker/scripts/smoke-downloader.sh ./bin/smoke-downloader.sh
COPY artifacts/tf-download-worker/scripts/smoke-deadline.mjs ./bin/smoke-deadline.mjs
RUN chmod 0555 /app/bin/start-smoke-worker.sh /app/bin/smoke-downloader.sh \
  /app/bin/smoke-deadline.mjs \
  && chmod -R a-w /app

USER 10001:10001
ENTRYPOINT ["/app/bin/start-smoke-worker.sh", "/app/bin/start-worker.sh"]
CMD ["node", "/app/dist/index.mjs"]

FROM runtime AS final
