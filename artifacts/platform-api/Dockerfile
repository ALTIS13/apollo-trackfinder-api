FROM postgres:16-bookworm AS postgres-role-init

COPY artifacts/platform-api/container/init-roles.sh /docker-entrypoint-initdb.d/010-platform-roles.sh
RUN chmod 0555 /docker-entrypoint-initdb.d/010-platform-roles.sh

FROM node:20-bookworm-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY lib/platform-contract/package.json ./lib/platform-contract/package.json
COPY lib/platform-db/package.json ./lib/platform-db/package.json
COPY artifacts/platform-api/package.json ./artifacts/platform-api/package.json

RUN pnpm install --frozen-lockfile --filter @workspace/platform-api...

COPY lib/platform-contract ./lib/platform-contract
COPY lib/platform-db ./lib/platform-db
COPY artifacts/platform-api ./artifacts/platform-api

RUN pnpm --dir artifacts/platform-api build
RUN pnpm --filter @workspace/platform-api deploy --prod --legacy /runtime
RUN find -L /runtime/node_modules/argon2 -name '*.node' -print -quit | grep -q .

FROM node:20-bookworm-slim AS runtime

RUN groupadd --gid 10001 apollo \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin apollo

WORKDIR /app

COPY --from=builder /workspace/artifacts/platform-api/dist ./dist
COPY --from=builder /runtime/node_modules ./node_modules
COPY --from=builder /workspace/lib/platform-db/migrations /app/migrations
COPY artifacts/platform-api/container/start-api.sh ./bin/start-api.sh

RUN chmod 0555 /app/bin/start-api.sh \
  && chmod -R a-w /app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER 10001:10001
ENTRYPOINT ["/app/bin/start-api.sh"]
CMD ["node", "/app/dist/index.mjs"]
