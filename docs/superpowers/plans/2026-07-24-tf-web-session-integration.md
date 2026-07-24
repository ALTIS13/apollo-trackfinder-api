# Apollo TF Web Session Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Apollo TF web player use the merged Platform PKCE browser session, CSRF boundary, entitlement policy, and one-time WebSocket tickets without exposing bearer tokens or retaining the legacy browser UUID.

**Architecture:** A music-player-local session adapter owns credentialed requests and keeps the CSRF token in memory. A React auth boundary loads `/api/auth/me` before protected providers mount, while all generated and manual API calls receive cookie/CSRF request options from the adapter. Player synchronization obtains a new one-use ticket before every WebSocket connection attempt and stops reconnecting when authentication or policy is denied.

**Tech Stack:** React 19, TypeScript, Vite, TanStack Query, Wouter, Vitest 4, jsdom, Testing Library, Fastify TF API contract tests

## Global Constraints

- Production web origin is exactly `https://tf.apollot.ru`; production API origin is exactly `https://api.tf.apollot.ru`.
- Browser authorization is the host-only `__Host-apollo_tf` cookie. Do not store or transport a browser `sessionId`, bearer token, provider token, or Apollo Platform secret.
- JavaScript cannot read the API host's `__Host-apollo_tf_csrf` cookie. Keep only the `csrfToken` returned by `GET /api/auth/me` in memory.
- Every TF API request uses `credentials: "include"`.
- `POST`, `PUT`, `PATCH`, and `DELETE` requests require the in-memory `X-CSRF-Token`; fail before `fetch` when the token is absent.
- `GET /api/auth/start` is a top-level browser navigation. `POST /api/auth/logout` is a credentialed CSRF-protected request.
- `POST /api/ws/tickets` has no body and returns a one-use ticket. Obtain a fresh ticket before every initial WebSocket connection and every reconnect.
- The only WebSocket query parameter is `ticket`; never place cookies, CSRF values, account IDs, installation IDs, or legacy session IDs in the URL.
- `401` means unauthenticated, `403 module_access_denied` means the account lacks the capability, and `503` means an authentication or policy dependency is unavailable. Do not convert these states into an infinite retry loop.
- Do not modify the generated shared API client defaults because that package is also used by non-browser clients. Pass request options from the music player.
- Preserve the existing Apollo TF visual language for this functional stage. Do not add a marketing page, redesign the player, or create new product routes.
- Android remains deferred.
- Do not mutate HomeNode, Coolify, Caddy, UFW, DNS, or any remote deployment in this plan.
- Search, integrations, and download workers remain independently containerizable; container extraction is the next plan after this browser contract is merged.

---

### Task 1: Browser Session Adapter And Test Harness

**Files:**
- Modify: `artifacts/music-player/package.json`
- Modify: `artifacts/music-player/vite.config.ts`
- Create: `artifacts/music-player/src/test/setup.ts`
- Create: `artifacts/music-player/src/lib/tf-session-client.ts`
- Test: `artifacts/music-player/src/lib/tf-session-client.test.ts`

**Interfaces:**
- Consumes: `apiUrl(path: string): string` and `API_BASE` from `src/lib/api-config.ts`
- Produces: `TfBrowserSession`, `TfApiError`, `normalizeTfApiError()`, `loadTfSession()`, `clearTfSessionSecurityState()`, `tfRequestInit()`, `tfFetch()`, `startTfLogin()`, `logoutTfSession()`, `createWebSocketTicket()`, and `buildTfWebSocketUrl()`

- [ ] **Step 1: Add the player test harness and failing adapter tests**

Add these package entries:

```json
{
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "jsdom": "^29.1.1",
    "vitest": "^4.0.18"
  }
}
```

Change the Vite import to `import { defineConfig } from "vitest/config";` and add:

```ts
test: {
  environment: "jsdom",
  setupFiles: ["./src/test/setup.ts"],
  clearMocks: true,
},
```

Create `src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

Create tests that assert these exact request shapes:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TfApiError,
  buildTfWebSocketUrl,
  clearTfSessionSecurityState,
  createWebSocketTicket,
  loadTfSession,
  tfFetch,
  tfRequestInit,
} from "./tf-session-client";

const session = {
  accountId: "10000000-0000-4000-8000-000000000001",
  installationId: "20000000-0000-4000-8000-000000000002",
  entitlements: ["tf.search", "tf.downloads"],
  expiresAt: "2026-07-25T12:00:00.000Z",
  csrfToken: "csrf-canary",
};

describe("TF browser session client", () => {
  beforeEach(() => {
    clearTfSessionSecurityState();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("loads the session with credentials and retains CSRF only in memory", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(session), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await expect(loadTfSession()).resolves.toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/me$/),
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    expect(tfRequestInit({ method: "POST" }).headers).toEqual(
      expect.objectContaining({ "X-CSRF-Token": "csrf-canary" }),
    );
    expect(localStorage.length).toBe(0);
  });

  it("refuses unsafe requests before fetch when CSRF is absent", async () => {
    await expect(tfFetch("/tracks/play", { method: "POST" })).rejects.toMatchObject({
      code: "csrf_unavailable",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates an exact empty ticket request and builds a ticket-only socket URL", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify(session), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ticket: "a".repeat(43) }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));

    await loadTfSession();
    await expect(createWebSocketTicket()).resolves.toBe("a".repeat(43));
    expect(fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/ws\/tickets$/),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const request = vi.mocked(fetch).mock.calls.at(-1)?.[1];
    expect(request?.body).toBeUndefined();
    expect(buildTfWebSocketUrl("a".repeat(43))).toMatch(
      /^wss?:\/\/[^?]+\/api\/ws\?ticket=a{43}$/,
    );
  });

  it.each([
    [401, "unauthorized", "unauthenticated"],
    [403, "module_access_denied", "forbidden"],
    [503, "policy_unavailable", "unavailable"],
  ])("classifies status %s and code %s", async (status, code, kind) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: code }), {
      status,
      headers: { "Content-Type": "application/json" },
    }));

    const error = await tfFetch("/auth/me").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TfApiError);
    expect(error).toMatchObject({ status, code, kind });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-session-client.test.ts
```

Expected: FAIL because `tf-session-client.ts` does not exist.

- [ ] **Step 3: Implement the browser session adapter**

Implement these exact public contracts:

```ts
export interface TfBrowserSession {
  accountId: string;
  installationId: string;
  entitlements: string[];
  expiresAt: string;
  csrfToken: string;
}

export type TfApiErrorKind =
  | "unauthenticated"
  | "forbidden"
  | "unavailable"
  | "invalid"
  | "transport";

export class TfApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly kind: TfApiErrorKind,
  ) {
    super(code);
    this.name = "TfApiError";
  }
}

export function normalizeTfApiError(error: unknown): TfApiError;
export function clearTfSessionSecurityState(): void;
export function tfRequestInit(init?: RequestInit): RequestInit;
export async function tfFetch<T>(path: string, init?: RequestInit): Promise<T>;
export async function loadTfSession(): Promise<TfBrowserSession>;
export function startTfLogin(): void;
export async function logoutTfSession(): Promise<void>;
export async function createWebSocketTicket(): Promise<string>;
export function buildTfWebSocketUrl(ticket: string): string;
```

Implementation rules:

```ts
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let csrfToken: string | null = null;

export function tfRequestInit(init: RequestInit = {}): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (UNSAFE_METHODS.has(method)) {
    if (csrfToken === null) throw new TfApiError(0, "csrf_unavailable", "unauthenticated");
    headers.set("X-CSRF-Token", csrfToken);
  }
  return { ...init, method, credentials: "include", headers };
}
```

`tfFetch` must call `fetch(apiUrl(path), tfRequestInit(init))`, parse JSON only when present, return `undefined` for `204`, and throw `TfApiError` with:

```ts
const kind =
  response.status === 401 ? "unauthenticated"
  : response.status === 403 ? "forbidden"
  : response.status === 503 ? "unavailable"
  : "invalid";
```

Network failures become `new TfApiError(0, "transport_unavailable", "transport")`. `loadTfSession` validates all five response fields before assigning the module-scoped CSRF token. `startTfLogin` calls `window.location.assign(apiUrl("/auth/start"))`. `logoutTfSession` POSTs `/auth/logout` and clears the token in `finally`. `createWebSocketTicket` POSTs `/ws/tickets` without `body` or `Content-Type`, validates a 43-character base64url ticket, and returns it. `buildTfWebSocketUrl` converts `API_BASE` to `ws:` or `wss:` and appends only `/ws?ticket=<encoded ticket>`.

Normalize unknown failures without discarding typed API failures:

```ts
export function normalizeTfApiError(error: unknown): TfApiError {
  return error instanceof TfApiError
    ? error
    : new TfApiError(0, "transport_unavailable", "transport");
}
```

- [ ] **Step 4: Run focused tests, typecheck, and commit**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-session-client.test.ts
pnpm --filter @workspace/music-player typecheck
```

Expected: all adapter tests PASS and TypeScript exits 0.

Commit:

```bash
git add artifacts/music-player/package.json artifacts/music-player/vite.config.ts artifacts/music-player/src/test/setup.ts artifacts/music-player/src/lib/tf-session-client.ts artifacts/music-player/src/lib/tf-session-client.test.ts pnpm-lock.yaml
git commit -m "feat(tf-web): add browser session client"
```

---

### Task 2: Auth Boundary And Entitlement-Aware Application Mount

**Files:**
- Create: `artifacts/music-player/src/auth/tf-auth.tsx`
- Create: `artifacts/music-player/src/auth/TfSessionBoundary.tsx`
- Test: `artifacts/music-player/src/auth/tf-auth.test.tsx`
- Modify: `artifacts/music-player/src/App.tsx`
- Modify: `artifacts/music-player/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `TfBrowserSession`, `TfApiError`, `loadTfSession()`, `startTfLogin()`, `logoutTfSession()`
- Produces: `TfAuthProvider`, `useTfAuth()`, `TfSessionBoundary`

- [ ] **Step 1: Write failing auth-state tests**

Test with Testing Library that:

```tsx
it("does not mount protected children before /auth/me succeeds");
it("shows sign in after a 401 and navigates through /auth/start");
it("shows retry after a 503 or transport failure");
it("shows module locked when tf.search is absent");
it("clears query data and protected UI after logout");
```

Mock only `@/lib/tf-session-client`; assert that a child canary is absent during loading and on unauthenticated/unavailable/locked states. For the successful fixture use the Task 1 `TfBrowserSession` shape. For logout assert `queryClient.getQueryCache().getAll()` is empty.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/auth/tf-auth.test.tsx
```

Expected: FAIL because the provider and boundary do not exist.

- [ ] **Step 3: Implement the provider and boundary**

Expose this context:

```ts
export type TfAuthStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "unavailable";

export interface TfAuthContextValue {
  status: TfAuthStatus;
  session: TfBrowserSession | null;
  error: TfApiError | null;
  refresh: () => Promise<void>;
  login: () => void;
  logout: () => Promise<void>;
  hasEntitlement: (capability: string) => boolean;
}
```

Provider behavior:

```ts
const refresh = useCallback(async () => {
  setState({ status: "loading", session: null, error: null });
  try {
    const session = await loadTfSession();
    setState({ status: "authenticated", session, error: null });
  } catch (error) {
    const apiError = normalizeTfApiError(error);
    setState({
      status: apiError.kind === "unauthenticated" ? "unauthenticated" : "unavailable",
      session: null,
      error: apiError,
    });
  }
}, []);
```

Call `refresh()` once on mount. `logout()` calls `logoutTfSession()`, then `queryClient.clear()`, then sets unauthenticated state in `finally`. `hasEntitlement` is a strict `session.entitlements.includes(capability)`.

The boundary uses existing typography, button, border, and background tokens. It renders:

```tsx
if (status === "loading") return <SessionLoading />;
if (status === "unauthenticated") return <SignInState onLogin={login} />;
if (status === "unavailable") return <UnavailableState onRetry={refresh} />;
if (!hasEntitlement("tf.search")) return <ModuleLockedState />;
return children;
```

Do not mount `PlayerProvider`, `Router`, page hooks, or `Player` outside the authenticated and `tf.search`-entitled branch.

Compose `App.tsx` in this order:

```tsx
<QueryClientProvider client={queryClient}>
  <TooltipProvider>
    <TfAuthProvider>
      <TfSessionBoundary>
        <PlayerProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppLayout />
          </WouterRouter>
          <Toaster />
        </PlayerProvider>
      </TfSessionBoundary>
    </TfAuthProvider>
  </TooltipProvider>
</QueryClientProvider>
```

Add a compact `LogOut` icon button at the bottom of `Sidebar`; call `useTfAuth().logout`, show the abbreviated account ID as non-sensitive session context, and use the icon's `title="Выйти"` tooltip.

- [ ] **Step 4: Run tests, typecheck, and commit**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/auth/tf-auth.test.tsx
pnpm --filter @workspace/music-player typecheck
```

Expected: auth tests PASS and TypeScript exits 0.

Commit:

```bash
git add artifacts/music-player/src/auth artifacts/music-player/src/App.tsx artifacts/music-player/src/components/Sidebar.tsx
git commit -m "feat(tf-web): gate player behind platform session"
```

---

### Task 3: Replace Legacy Browser Identity In HTTP Calls

**Files:**
- Modify: `artifacts/music-player/src/pages/Home.tsx`
- Modify: `artifacts/music-player/src/pages/Discover.tsx`
- Modify: `artifacts/music-player/src/components/TrackCard.tsx`
- Modify: `artifacts/music-player/src/hooks/use-player.tsx`
- Modify: `artifacts/music-player/src/hooks/use-spotify.ts`
- Modify: `artifacts/music-player/src/hooks/use-yandex.ts`
- Create: `artifacts/music-player/src/lib/tf-api-migration.test.ts`

**Interfaces:**
- Consumes: `tfFetch<T>()` and `tfRequestInit()` from Task 1
- Produces: no new public interface; every existing data hook keeps its current return shape

- [ ] **Step 1: Write failing request and legacy-removal tests**

Add tests using mocked `fetch` and source-file assertions:

```ts
it("loads recommendations without a sessionId query and with credentials");
it("posts Spotify and Yandex logout with CSRF");
it("navigates to Spotify login without sid");
it("posts the Yandex token through the CSRF adapter");
it("contains no legacy identity transport in the migrated HTTP call sites");
```

For the source scan, resolve `src` from `import.meta.dirname` and inspect `Home.tsx`, `Discover.tsx`, `TrackCard.tsx`, `use-spotify.ts`, and `use-yandex.ts`. Assert `getClientSessionId`, `X-Client-Session`, `trackfinder_session_id`, `sessionId`, and `sid` are absent from those migrated HTTP call sites. `use-player.tsx` may retain its existing WebSocket-only `getClientSessionId` reference until Task 4 replaces that lifecycle, but its HTTP `/tracks/play` body must not contain `sessionId`.

- [ ] **Step 2: Run the migration test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-api-migration.test.ts
```

Expected: FAIL on current `sessionId`, `X-Client-Session`, GET logout, and uncredentialed requests.

- [ ] **Step 3: Migrate generated and manual HTTP calls**

Use generated request options without changing `lib/api-client-react`:

```ts
const searchMutation = useSearchTracks({
  request: tfRequestInit({ method: "POST" }),
});

getGetTrackStreamQueryOptions(track.id, {
  request: tfRequestInit({ method: "GET" }),
});

getGetTrackDownloadQueryOptions(track.id, {
  request: tfRequestInit({ method: "GET" }),
});
```

Replace manual track calls:

```ts
await tfFetch<{ results: TrackResult[] }>("/tracks/recommendations?limit=20");

await tfFetch<void>("/tracks/play", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    trackId: currentTrack.id,
    artist: currentTrack.artist,
    title: currentTrack.title,
  }),
});
```

Provider hooks call `tfFetch` directly. Spotify login becomes:

```ts
export function spotifyLoginUrl(): string {
  return apiUrl("/spotify/login");
}
```

Both provider logout mutations use `{ method: "POST" }`. Yandex token remains JSON POST. All provider GET calls preserve their existing query parameters and return types. Remove every HTTP use of `getClientSessionId`; leave only the pre-existing WebSocket reference for Task 4.

- [ ] **Step 4: Run migration tests and the complete player suite**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-api-migration.test.ts
pnpm --filter @workspace/music-player test
pnpm --filter @workspace/music-player typecheck
```

Expected: all player tests PASS, no legacy identity transport remains in migrated HTTP call sites or the `/tracks/play` body, and TypeScript exits 0.

Commit:

```bash
git add artifacts/music-player/src
git commit -m "feat(tf-web): migrate protected api calls"
```

---

### Task 4: One-Time Ticket WebSocket Lifecycle

**Files:**
- Create: `artifacts/music-player/src/lib/tf-websocket.ts`
- Test: `artifacts/music-player/src/lib/tf-websocket.test.ts`
- Modify: `artifacts/music-player/src/lib/tf-api-migration.test.ts`
- Modify: `artifacts/music-player/src/hooks/use-player.tsx`
- Delete: `artifacts/music-player/src/lib/client-session.ts`

**Interfaces:**
- Consumes: `createWebSocketTicket()`, `buildTfWebSocketUrl()`, and `TfApiError`
- Produces: `TfWebSocketLifecycle`

- [ ] **Step 1: Write failing lifecycle tests**

Use fake timers and injected dependencies to assert:

```ts
it("requests a fresh ticket before the initial socket");
it("requests a different fresh ticket before every reconnect");
it("uses a URL whose only query key is ticket");
it("backs off reconnects from 3000ms up to 30000ms");
it("does not reconnect after unauthenticated, forbidden, or unavailable ticket errors");
it("cancels pending ticket work and timers after stop");
it("contains no runtime reference to getClientSessionId, X-Client-Session, trackfinder_session_id, sessionId query transport, or sid query transport");
```

Use a fake socket implementing `onopen`, `onmessage`, `onclose`, `onerror`, `readyState`, and `close()`. The ticket dependency returns ordered values such as `"a".repeat(43)` and `"b".repeat(43)` so reuse is observable.

- [ ] **Step 2: Run the lifecycle test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-websocket.test.ts
```

Expected: FAIL because `TfWebSocketLifecycle` does not exist.

- [ ] **Step 3: Implement the isolated lifecycle**

Expose:

```ts
export interface TfWebSocketLifecycleOptions {
  createTicket: () => Promise<string>;
  buildUrl: (ticket: string) => string;
  createSocket: (url: string) => WebSocket;
  onMessage: (event: MessageEvent) => void;
  onTerminalError: (error: TfApiError) => void;
  schedule?: typeof window.setTimeout;
  cancelSchedule?: typeof window.clearTimeout;
}

export class TfWebSocketLifecycle {
  constructor(options: TfWebSocketLifecycleOptions);
  start(): void;
  stop(): void;
}
```

The lifecycle must:

```ts
private async connect(attempt: number): Promise<void> {
  if (!this.running || attempt !== this.attempt) return;
  try {
    const ticket = await this.options.createTicket();
    if (!this.running || attempt !== this.attempt) return;
    const socket = this.options.createSocket(this.options.buildUrl(ticket));
    this.socket = socket;
    socket.onopen = () => { this.delayMs = 3000; };
    socket.onmessage = this.options.onMessage;
    socket.onerror = () => socket.close();
    socket.onclose = () => this.scheduleReconnect();
  } catch (error) {
    const apiError = normalizeTfApiError(error);
    if (["unauthenticated", "forbidden", "unavailable"].includes(apiError.kind)) {
      this.running = false;
      this.options.onTerminalError(apiError);
      return;
    }
    this.scheduleReconnect();
  }
}
```

`start()` is idempotent, increments an attempt generation, and starts `connect`. `scheduleReconnect()` waits the current delay, doubles it with a `30000` cap, increments the generation, and calls `connect` so every attempt obtains a new ticket. `stop()` marks the lifecycle stopped, increments the generation to invalidate pending ticket promises, clears the timer, nulls `onclose`, and closes the active socket.

Move only socket creation/reconnect ownership out of `use-player.tsx`; retain its player-state message application and outgoing state serialization. Remove the final `getClientSessionId` import and delete `src/lib/client-session.ts`. Extend the migration test to scan all runtime `.ts`/`.tsx` files under `src`, excluding tests, and prove that no legacy identity transport remains. On terminal authentication/policy failure, show one destructive toast and leave reconnection stopped until `PlayerProvider` is remounted after auth refresh or relogin.

- [ ] **Step 4: Run lifecycle and player tests, typecheck, and commit**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-websocket.test.ts
pnpm --filter @workspace/music-player test
pnpm --filter @workspace/music-player typecheck
```

Expected: all lifecycle/player tests PASS and TypeScript exits 0.

Commit:

```bash
git add artifacts/music-player/src/lib/tf-websocket.ts artifacts/music-player/src/lib/tf-websocket.test.ts artifacts/music-player/src/lib/tf-api-migration.test.ts artifacts/music-player/src/hooks/use-player.tsx artifacts/music-player/src/lib/client-session.ts
git commit -m "feat(tf-web): use one-time websocket tickets"
```

---

### Task 5: Integrated Contract Validation And Release Record

**Files:**
- Modify: `IMPLEMENTATION_STATUS.md`
- Modify: `docs/superpowers/plans/2026-07-24-tf-web-session-integration.md`

**Interfaces:**
- Consumes: all Task 1-4 behavior and merged API browser-contract tests
- Produces: a validated branch ready for independent whole-branch review and merge into `main`

- [ ] **Step 1: Run the complete local validation matrix**

Run:

```bash
pnpm --filter @workspace/music-player test
pnpm --filter @workspace/music-player typecheck
pnpm --filter @workspace/music-player build
pnpm --filter @workspace/api-server test -- src/routes/auth.test.ts src/app-auth-boundary.test.ts src/routes/websocket-tickets.test.ts src/lib/tf-policy.test.ts src/ws.test.ts
pnpm run typecheck
docker compose config
```

Expected:

```text
music-player tests: PASS
music-player typecheck: exit 0
music-player Vite build: exit 0
selected API browser contract tests: PASS
root typecheck: exit 0
root Compose config: exit 0
```

- [ ] **Step 2: Run exact legacy and secret-boundary scans**

Run:

```bash
rg -n "getClientSessionId|X-Client-Session|trackfinder_session_id|[?&]sessionId=|[?&]sid=" artifacts/music-player/src
rg -n "Bearer |APOLLO_PLATFORM_CLIENT_SECRET|SPOTIFY_CLIENT_SECRET|YANDEX_TOKEN" artifacts/music-player/src
```

Expected: both commands produce no runtime matches.

- [ ] **Step 3: Record implementation state**

Update `IMPLEMENTATION_STATUS.md` with:

```markdown
### TF web Platform session

- Status: implemented and locally validated
- Browser auth: Platform PKCE through `api.tf.apollot.ru`, host-only TF cookie
- CSRF: `/api/auth/me` token retained in memory and sent on unsafe requests
- Policy: `tf.search` gates application mount; server remains authoritative for every capability
- WebSocket: one-time ticket acquired before every connection attempt
- Legacy browser UUID: removed
- Remote infrastructure: unchanged; domains/Caddy/Coolify deployment still requires preflight and explicit approval
```

Mark every completed checkbox in this plan and ensure `.superpowers/sdd/progress.md` names the reviewed commit range for each task.

- [ ] **Step 4: Commit the release record**

Run:

```bash
git add IMPLEMENTATION_STATUS.md docs/superpowers/plans/2026-07-24-tf-web-session-integration.md
git commit -m "docs: record tf web session integration"
```

Expected: commit succeeds and `git status --short` is empty.

- [ ] **Step 5: Independent final review and merge preparation**

Generate a whole-branch review package from merge base to HEAD. The final reviewer must return both `SPEC PASS` and `QUALITY APPROVED`; Critical and Important findings require one consolidated fix pass followed by re-review. After approval, merge the feature branch into `main`, rerun the Task 5 validation matrix on `main`, push both branch and `main`, and confirm both remote refs.
