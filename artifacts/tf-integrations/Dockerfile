FROM docker.io/library/postgres:17-bookworm@sha256:4f736ae292687621d4dbe0d499ffd024a36bd2ee7d8ca6f2ccd4c800f047b394 AS postgres-role-init

COPY artifacts/tf-integrations/container/init-roles.sh /docker-entrypoint-initdb.d/010-tf-integrations-roles.sh
RUN chmod 0555 /docker-entrypoint-initdb.d/010-tf-integrations-roles.sh

FROM docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY lib/module-runtime-contract/package.json ./lib/module-runtime-contract/package.json
COPY lib/tf-integrations-contract/package.json ./lib/tf-integrations-contract/package.json
COPY lib/tf-integrations-db/package.json ./lib/tf-integrations-db/package.json
COPY artifacts/tf-integrations/package.json ./artifacts/tf-integrations/package.json

RUN pnpm install --frozen-lockfile --filter @workspace/tf-integrations...

COPY lib/module-runtime-contract ./lib/module-runtime-contract
COPY lib/tf-integrations-contract ./lib/tf-integrations-contract
COPY lib/tf-integrations-db ./lib/tf-integrations-db
COPY artifacts/tf-integrations ./artifacts/tf-integrations

RUN pnpm --dir artifacts/tf-integrations build
RUN pnpm --filter @workspace/tf-integrations deploy --prod --legacy /runtime

FROM docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime

RUN groupadd --gid 10001 tf-integrations \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin tf-integrations

WORKDIR /app

COPY --from=builder /workspace/artifacts/tf-integrations/dist ./dist
COPY --from=builder /runtime/node_modules ./node_modules
COPY artifacts/tf-integrations/container/start-integrations.sh ./bin/start-integrations.sh

RUN chmod 0555 /app/bin/start-integrations.sh \
  && chmod -R a-w /app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER 10001:10001
ENTRYPOINT ["/app/bin/start-integrations.sh"]
CMD ["node", "/app/dist/index.mjs"]

FROM runtime AS runner
