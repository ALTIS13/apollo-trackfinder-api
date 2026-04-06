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

RUN printf 'packages:\n  - artifacts/api-server\n  - lib/db\n  - lib/api-zod\n' > pnpm-workspace.yaml

COPY lib/db/package.json ./lib/db/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY artifacts/api-server/package.json ./artifacts/api-server/

RUN pnpm install --frozen-lockfile

COPY lib/db ./lib/db
COPY lib/api-zod ./lib/api-zod
COPY artifacts/api-server ./artifacts/api-server

RUN pnpm --filter @workspace/api-server run build

FROM node:20-alpine AS runner

RUN apk add --no-cache python3 py3-pip ffmpeg \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./dist

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.mjs"]
