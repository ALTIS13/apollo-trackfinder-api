FROM docker.io/library/node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

WORKDIR /app

RUN npm install -g pnpm@10.33.2

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./

RUN node -e " \
  const fs = require('fs'); \
  const y = fs.readFileSync('pnpm-workspace.yaml', 'utf8'); \
  const replaced = y.replace(/^packages:[\s\S]*?(?=\n[a-zA-Z])/m, \
    'packages:\n  - artifacts/music-player\n  - lib/api-client-react\n\n'); \
  fs.writeFileSync('pnpm-workspace.yaml', replaced);"

COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY artifacts/music-player/package.json ./artifacts/music-player/

RUN pnpm install --frozen-lockfile

COPY lib/api-client-react ./lib/api-client-react
COPY artifacts/music-player ./artifacts/music-player

ARG VITE_API_URL
ENV VITE_API_URL=${VITE_API_URL}

RUN pnpm --filter @workspace/music-player run build

FROM docker.io/library/nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752 AS runner

COPY --from=builder /app/artifacts/music-player/dist/public /usr/share/nginx/html

RUN printf 'server {\n\
    listen 80;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    location = /healthz {\n\
        access_log off;\n\
        default_type text/plain;\n\
        return 200 "ok\\n";\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
HEALTHCHECK CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
