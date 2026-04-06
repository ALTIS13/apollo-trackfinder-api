FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm

COPY pnpm-lock.yaml tsconfig.base.json tsconfig.json ./

COPY package.json /tmp/root-pkg.json
RUN node -e " \
  const pkg = require('/tmp/root-pkg.json'); \
  delete pkg.dependencies; \
  delete pkg.scripts; \
  require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2));"

RUN printf 'packages:\n  - artifacts/music-player\n  - lib/api-client-react\n' > pnpm-workspace.yaml

COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/music-player/package.json ./artifacts/music-player/

RUN pnpm install --frozen-lockfile

COPY lib/api-client-react ./lib/api-client-react
COPY artifacts/music-player ./artifacts/music-player
COPY attached_assets ./attached_assets

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

RUN pnpm --filter @workspace/music-player run build

FROM nginx:alpine AS runner

COPY --from=builder /app/artifacts/music-player/dist/public /usr/share/nginx/html

RUN printf 'server {\n\
    listen 80;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
