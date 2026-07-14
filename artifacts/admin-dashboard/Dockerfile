FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY artifacts/admin-dashboard ./artifacts/admin-dashboard

RUN pnpm install --frozen-lockfile --filter @workspace/admin-dashboard...

ARG VITE_ADMIN_API_URL
ENV VITE_ADMIN_API_URL=$VITE_ADMIN_API_URL
RUN pnpm --filter @workspace/admin-dashboard build

FROM nginx:1.27-alpine

COPY artifacts/admin-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/artifacts/admin-dashboard/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1
