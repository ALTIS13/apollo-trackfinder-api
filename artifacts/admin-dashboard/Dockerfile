FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY artifacts/admin-dashboard ./artifacts/admin-dashboard

RUN pnpm install --frozen-lockfile --filter @workspace/admin-dashboard...

RUN pnpm --filter @workspace/admin-dashboard build

FROM nginx:1.27-alpine

ENV APOLLO_API_UPSTREAM=http://127.0.0.1:8080 \
    NGINX_ENVSUBST_FILTER='^(APOLLO_API_UPSTREAM|ADMIN_DASHBOARD_TOKEN)$'

COPY artifacts/admin-dashboard/nginx.conf /etc/nginx/templates/default.conf.template
COPY artifacts/admin-dashboard/docker-entrypoint.d/16-admin-dashboard-defaults.envsh /docker-entrypoint.d/16-admin-dashboard-defaults.envsh
RUN chmod +x /docker-entrypoint.d/16-admin-dashboard-defaults.envsh
COPY --from=build /app/artifacts/admin-dashboard/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1
