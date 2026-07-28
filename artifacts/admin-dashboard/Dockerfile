FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY lib/admin-dashboard-contract/package.json ./lib/admin-dashboard-contract/
COPY artifacts/admin-dashboard ./artifacts/admin-dashboard
COPY lib/admin-dashboard-contract ./lib/admin-dashboard-contract

RUN pnpm install --frozen-lockfile --filter @workspace/admin-dashboard...

RUN pnpm --filter @workspace/admin-dashboard build

FROM docker.io/library/nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10 AS default

ENV APOLLO_API_UPSTREAM=http://127.0.0.1:8080 \
    NGINX_ENVSUBST_FILTER='^(APOLLO_API_UPSTREAM|ADMIN_DASHBOARD_TOKEN)$'

COPY artifacts/admin-dashboard/nginx.conf /etc/nginx/templates/default.conf.template
COPY artifacts/admin-dashboard/docker-entrypoint.d/16-admin-dashboard-defaults.envsh /docker-entrypoint.d/16-admin-dashboard-defaults.envsh
RUN chmod +x /docker-entrypoint.d/16-admin-dashboard-defaults.envsh
COPY --from=build /app/artifacts/admin-dashboard/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1
