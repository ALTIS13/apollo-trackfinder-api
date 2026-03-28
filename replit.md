# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **Media search**: yt-dlp (system) + SoundCloud API (HTTP)
- **System deps**: yt-dlp, ffmpeg (installed via Nix)

## Music Player API

### Endpoints
- `POST /api/tracks/search` — search YouTube + SoundCloud for track variants, returns classified & ranked list with `score` (0-100)
- `POST /api/tracks/batch-search` — bulk search up to 100 tracks; returns best match + similarity score per track; auto-selection at ≥80%
- `GET /api/tracks/:id/stream` — get stream URL (HLS or direct audio) for a track
- `GET /api/tracks/:id/download` — get download URL for a track

### Architecture
- Track IDs encode the source URL as `yt_<base64url>` (YouTube) or `sc_<base64url>` (SoundCloud)
- Search results are cached in PostgreSQL (`track_search_cache`) with 1-hour TTL
- Classification: `original | remix | live | cover` — rule-based regex on track title
- Ranking: combined score from title similarity + type weight + view count + duration proximity
- YouTube: uses `yt-dlp` CLI with `ytsearch:` prefix for search, `--get-url` for stream resolution
- SoundCloud: HTTP fetch to SoundCloud API v2 with dynamic client_id extraction (cached 30 min)

## Music Player Frontend (`artifacts/music-player`)

React + Vite SPA with dark professional design.

### Pages & Components
- `src/pages/Home.tsx` — Hero search page + results list with filter tabs
- `src/components/TrackCard.tsx` — Individual track card: thumbnail, title, artist, duration, type/source badges, play + download buttons
- `src/components/Player.tsx` — Persistent bottom player bar: thumbnail, title, artist, progress bar, play/pause/skip controls, time display
- `src/hooks/use-player.tsx` — PlayerContext: HTML5 Audio playback, stream URL fetching, progress tracking, seek
- `src/components/ui/badge.tsx` — Extended Badge with variants: original (green), remix (purple), live (orange), cover (blue), youtube, soundcloud
- `src/lib/utils.ts` — `cn()` helper + `formatDuration()` (seconds → mm:ss)

### Key behaviors
- Search calls `useSearchTracks` mutation; results are ordered originals-first by the API
- Filter buttons (All/Original/Remix/Live/Cover) filter the already-sorted results client-side
- Play click → fetches `/api/tracks/:id/stream` → sets `audio.src` → plays via HTML5 Audio
- Download click → fetches `/api/tracks/:id/download` → triggers `<a download>` programmatic click
- Skeleton loading cards shown during search; error/empty states handled
- Player bar is hidden until first track is selected (hooks appear above early return to respect Rules of Hooks)

## Spotify Favorites Integration

### Setup Required
Before Spotify OAuth works, you must add the redirect URI in the Spotify Developer Dashboard:
- Go to https://developer.spotify.com/dashboard → your app → Edit Settings → Redirect URIs
- Add: `https://<your-replit-domain>/api/spotify/callback`

### Backend Endpoints (all under `/api/spotify/`)
- `GET /spotify/login` — redirects to Spotify OAuth authorize page
- `GET /spotify/callback` — OAuth callback; stores tokens in DB, redirects to `/favorites?spotify_connected=1`
- `GET /spotify/status` — returns `{ connected, displayName, spotifyUserId }`
- `GET /spotify/logout` — clears session + deletes DB token
- `GET /spotify/liked?offset&limit` — paginated liked songs (50 per page)
- `GET /spotify/playlists` — user's playlists (up to 50)
- `GET /spotify/playlists/:id/tracks?offset&limit` — tracks in a playlist
- `GET /spotify/top-tracks?time_range` — top tracks (short_term/medium_term/long_term)

### Session & Auth
- `express-session` stores session ID in a cookie (in-memory store in dev, persistent in prod via env)
- `SESSION_SECRET` env var controls session signing
- `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` required
- Tokens stored in `spotify_tokens` PostgreSQL table with auto-refresh logic (refreshes if expiry < 60s)

### Frontend
- `src/hooks/use-spotify.ts` — all Spotify API hooks using React Query + `credentials: "include"`
- `src/hooks/use-yandex.ts` — all Yandex Music API hooks using React Query + `credentials: "include"`
- `src/pages/Favorites.tsx` — full page with service switcher (Spotify | Yandex Music), connect prompts, catalog tabs, track list, pagination
- Each track has a "Find variants" button → navigates to `/` with `?artist=...&title=...` to auto-search
- `src/App.tsx` — NavBar with Discover/Favorites links, `/favorites` route

## Yandex Music Integration

### Auth
- Token-based: user gets an OAuth token from Yandex and pastes it into the app
- Backend validates token against `/account/status`, stores in `yandex_tokens` table keyed by session_id

### Backend Endpoints (all under `/api/yandex/`)
- `POST /yandex/token` — validate and store token; returns `{ ok, displayName, login, userId }`
- `GET /yandex/status` — returns `{ connected, displayName, login, userId }`
- `GET /yandex/logout` — clears session token from DB
- `GET /yandex/liked?offset&limit` — paginated liked tracks (resolves track IDs in batches of 50)
- `GET /yandex/playlists` — user's playlists list
- `GET /yandex/playlists/:uid/:kind/tracks?offset&limit` — tracks in a specific playlist

### Yandex Music API Notes
- Base: `https://api.music.yandex.net`
- Auth header: `Authorization: OAuth <token>` + `X-Yandex-Music-Client: YandexMusicAndroid/24023621`
- Liked tracks come as `{ id, albumId }` refs → resolved via `GET /tracks?track-ids=id:albumId,...`
- Cover art: `coverUri` field has `%%` placeholder → replace with `200x200` for thumbnails

## TrackFinder Mobile (`artifacts/trackfinder-mobile`)

Expo React Native app targeting Android + web (Windows PWA). Uses the same backend API.

### Features
- **Search tab**: Full track-variant search via backend API, filter by type, play & download
- **Library tab**: Offline tracks downloaded to device storage (expo-file-system + expo-media-library)
- **Favorites tab**: Spotify OAuth + Yandex Music token connect, catalog browse, "Find Variants" → Search tab
- **Mini player**: Persistent bottom bar with progress, play/pause, stop (expo-av)

### Session
- Session ID stored in `AsyncStorage` (no cookies needed)
- All API calls include `X-Client-Session` header
- Spotify OAuth encodes session ID in `state` parameter

### Key files
- `app/(tabs)/index.tsx` — Search screen
- `app/(tabs)/library.tsx` — Offline library
- `app/(tabs)/favorites.tsx` — Spotify + Yandex favorites
- `hooks/use-player.tsx` — PlayerContext (expo-av)
- `hooks/use-library.tsx` — LibraryContext (AsyncStorage + expo-file-system)
- `hooks/use-session.ts` — session ID + apiFetch helper
- `constants/colors.ts` — dark theme + type/source color maps

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server
│   ├── music-player/       # React + Vite web frontend
│   └── trackfinder-mobile/ # Expo React Native mobile app (Android + web)
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
│       └── src/schema/     # trackCache.ts (PostgreSQL cache table)
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
