FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./

COPY lib/db/package.json ./lib/db/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY artifacts/api-server/package.json ./artifacts/api-server/

RUN pnpm install --frozen-lockfile

COPY lib/db ./lib/db
COPY lib/api-spec ./lib/api-spec
COPY lib/api-zod ./lib/api-zod
COPY artifacts/api-server ./artifacts/api-server

RUN pnpm --filter @workspace/api-server run build

FROM node:20-alpine AS runner

RUN apk add --no-cache python3 yt-dlp ffmpeg

WORKDIR /app

COPY --from=builder /app/artifacts/api-server/dist ./dist

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/index.mjs"]
