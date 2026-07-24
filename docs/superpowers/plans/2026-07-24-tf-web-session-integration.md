# Apollo TF Web Session Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Apollo TF web player use the merged Platform PKCE browser session, CSRF boundary, entitlement policy, and one-time WebSocket tickets without exposing bearer tokens or retaining the legacy browser UUID.

**Architecture:** A music-player-local session adapter owns credentialed requests and validates `/api/auth/me` without mutating security state. The React auth provider generation-checks each response before committing its CSRF token, cancels and clears protected queries during security transitions, and mounts protected providers only for the accepted session. Generated and manual API calls receive cookie/CSRF request options from the adapter. Player synchronization obtains a new one-use ticket before every WebSocket connection attempt and stops reconnecting when authentication or policy is denied.

**Tech Stack:** React 19, TypeScript, Vite, TanStack Query, Wouter, Vitest 4, jsdom, Testing Library, Fastify TF API contract tests

## Global Constraints

- Production web origin is exactly `https://tf.apollot.ru`; production API origin is exactly `https://api.tf.apollot.ru`.
- Browser authorization is the host-only `__Host-apollo_tf` cookie. Do not store or transport a browser `sessionId`, bearer token, provider token, or Apollo Platform secret.
- Browser-managed Yandex tokens are prohibited. New Yandex onboarding is deferred to server-side OAuth; already connected accounts retain server-backed status, read, and logout behavior.
- JavaScript cannot read the API host's `__Host-apollo_tf_csrf` cookie. Keep only the `csrfToken` returned by `GET /api/auth/me` in memory.
- `/api/auth/me` uses an unmanaged credentialed GET whose success, HTTP error, malformed body, and transport paths never clear or commit CSRF and never publish auth events. Only the mounted auth provider may clear before its refresh and commit a validated response after confirming its request generation is current.
- Every TF API request uses `credentials: "include"`.
- `POST`, `PUT`, `PATCH`, and `DELETE` requests require the in-memory `X-CSRF-Token`; fail before `fetch` when the token is absent.
- `GET /api/auth/start` is a top-level browser navigation. `POST /api/auth/logout` is a credentialed CSRF-protected request.
- `POST /api/ws/tickets` has no body and returns a one-use ticket. Obtain a fresh ticket before every initial WebSocket connection and every reconnect.
- The only WebSocket query parameter is `ticket`; never place cookies, CSRF values, account IDs, installation IDs, or legacy session IDs in the URL.
- `401` means unauthenticated, `403 module_access_denied` means the account lacks the capability, and `503` means an authentication or policy dependency is unavailable. Do not convert these states into an infinite retry loop.
- Confirmed invalidation and policy revalidation synchronously unmount protected UI, clear old CSRF and cached protected data, and cancel protected in-flight queries before any replacement `/api/auth/me` request.
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
- Produces: `TfBrowserSession`, `TfApiError`, `normalizeTfApiError()`, `fetchTfSession()`, `commitTfSessionSecurityState()`, `clearTfSessionSecurityState()`, `tfRequestInit()`, `tfFetch()`, `reportTfAuthError()`, `subscribeTfAuthSecurityEvents()`, `startTfLogin()`, `logoutTfSession()`, `createWebSocketTicket()`, and `buildTfWebSocketUrl()`

- [x] **Step 1: Add the player test harness and failing adapter tests**

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
  commitTfSessionSecurityState,
  createWebSocketTicket,
  fetchTfSession,
  tfFetch,
  tfRequestInit,
} from "./tf-session-client";

const session = {
  accountId: "10000000-0000-4000-8000-000000000001",
  installationId: "20000000-0000-4000-8000-000000000002",
  entitlements: ["tf.search", "tf.downloads"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  csrfToken: "c".repeat(42) + "A",
};

describe("TF browser session client", () => {
  beforeEach(() => {
    clearTfSessionSecurityState();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fetches the session without mutating CSRF until the provider accepts it", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(session), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const fetchedSession = await fetchTfSession();
    expect(fetchedSession).toEqual(session);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/me$/),
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
    expect(() => tfRequestInit({ method: "POST" })).toThrow();
    commitTfSessionSecurityState(fetchedSession);
    expect(tfRequestInit({ method: "POST" }).headers).toEqual(
      expect.objectContaining({ "X-CSRF-Token": "c".repeat(42) + "A" }),
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

    commitTfSessionSecurityState(await fetchTfSession());
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

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-session-client.test.ts
```

Expected: FAIL because `tf-session-client.ts` does not exist.

- [x] **Step 3: Implement the browser session adapter**

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
export async function fetchTfSession(): Promise<TfBrowserSession>;
export function commitTfSessionSecurityState(session: TfBrowserSession): void;
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

Network failures become `new TfApiError(0, "transport_unavailable", "transport")`. `fetchTfSession` performs its own unmanaged `GET /api/auth/me` with credentials, classifies HTTP/body/transport failures as typed `TfApiError`, and accepts only canonical UUID account/installation IDs, string entitlements, a valid future expiry, and a canonical unpadded 43-character base64url CSRF token. No `fetchTfSession` outcome clears or commits module CSRF or publishes an auth event; invalid candidates only throw `invalid_session`. `commitTfSessionSecurityState` revalidates and commits only a provider-accepted session. Normal protected `tfFetch` calls preserve their side-effecting behavior: confirmed `401` responses and exact core policy/WebSocket unavailability errors clear CSRF and publish application-local invalidation or revalidation events. `startTfLogin` calls `window.location.assign(apiUrl("/auth/start"))`. `logoutTfSession` only starts and awaits the CSRF-protected remote POST; the provider starts it while the current token is available, then immediately performs local invalidation without waiting. `createWebSocketTicket` POSTs `/ws/tickets` without `body` or `Content-Type`, validates a 43-character base64url ticket, and returns it. `buildTfWebSocketUrl` converts `API_BASE` to `ws:` or `wss:` and appends only `/ws?ticket=<encoded ticket>`.

Normalize unknown failures without discarding typed API failures:

```ts
export function normalizeTfApiError(error: unknown): TfApiError {
  return error instanceof TfApiError
    ? error
    : new TfApiError(0, "transport_unavailable", "transport");
}
```

- [x] **Step 4: Run focused tests, typecheck, and commit**

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
- Consumes: `TfBrowserSession`, `TfApiError`, `fetchTfSession()`, `commitTfSessionSecurityState()`, `startTfLogin()`, `logoutTfSession()`
- Produces: `TfAuthProvider`, `useTfAuth()`, `TfSessionBoundary`

- [x] **Step 1: Write failing auth-state tests**

Test with Testing Library that:

```tsx
it("does not mount protected children before /auth/me succeeds");
it("shows sign in after a 401 and navigates through /auth/start");
it("shows retry after a 503 or transport failure");
it("shows module locked when tf.search is absent");
it("clears query data and protected UI after logout");
it("clears query data and protected UI after a runtime tfFetch 401");
it("refreshes /auth/me once for duplicate core policy events and unmounts while pending");
it("ignores auth events and late refresh completion after provider cleanup");
```

Mock only `@/lib/tf-session-client`; assert that a child canary is absent during loading and on unauthenticated/unavailable/locked states. For the successful fixture use the Task 1 `TfBrowserSession` shape. For logout assert `queryClient.getQueryCache().getAll()` is empty.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/auth/tf-auth.test.tsx
```

Expected: FAIL because the provider and boundary do not exist.

- [x] **Step 3: Implement the provider and boundary**

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

Provider behavior is generation-guarded and single-flight. It subscribes before the initial `refresh()`: invalidation and policy replacement synchronously clear CSRF, cancel protected queries, clear the `QueryClient`, and unmount protected children. Policy events share one replacement `/auth/me` refresh. The provider alone classifies a current generation's typed fetch failure into unauthenticated/unavailable UI, while stale failures are ignored without adapter side effects. A validated session is committed only after mounted/current-generation acceptance; an account A cache, success, error, or malformed response cannot cross into account B. Logout starts its CSRF-protected server request before immediate local invalidation and suppresses the eventual remote result. Logout, invalidation, policy replacement, and cleanup invalidate pending generations, so late promises cannot repopulate CSRF or remount protected UI. `hasEntitlement` is a strict `session.entitlements.includes(capability)`.

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

- [x] **Step 4: Run tests, typecheck, and commit**

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

- [x] **Step 1: Write failing request and legacy-removal tests**

Add tests using mocked `fetch` and source-file assertions:

```ts
it("loads recommendations without a sessionId query and with credentials");
it("posts Spotify and Yandex logout with CSRF");
it("navigates to Spotify login without sid");
it("renders Yandex disconnected without accepting or transporting a provider token");
it("reads CSRF at Home search mutation time instead of reusing a render snapshot");
it("forwards generated search auth/policy errors into the auth channel");
it("contains no legacy identity transport in the migrated HTTP call sites");
it("contains no browser-managed Yandex provider-token flow in runtime TypeScript");
```

For the source scan, resolve `src` from `import.meta.dirname` and inspect `Home.tsx`, `Discover.tsx`, `TrackCard.tsx`, `use-spotify.ts`, and `use-yandex.ts`. Assert `getClientSessionId`, `X-Client-Session`, `trackfinder_session_id`, `sessionId`, and `sid` are absent from those migrated HTTP call sites. `use-player.tsx` may retain its existing WebSocket-only `getClientSessionId` reference until Task 4 replaces that lifecycle, but its HTTP `/tracks/play` body must not contain `sessionId`.

- [x] **Step 2: Run the migration test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-api-migration.test.ts
```

Expected: FAIL on current `sessionId`, `X-Client-Session`, GET logout, and uncredentialed requests.

- [x] **Step 3: Migrate generated and manual HTTP calls**

Use a local TanStack mutation without changing `lib/api-client-react`. Construct request options immediately before each generated search request:

```ts
const searchMutation = useMutation({
  mutationFn: (data: SearchRequest) =>
    searchTracks(data, tfRequestInit({ method: "POST" })),
  onError: (error) => {
    reportTfAuthError(error);
  },
});
```

Generated stream/download options remain caller-supplied:

```ts
getGetTrackStreamQueryOptions(track.id, {
  request: tfRequestInit({ method: "GET" }),
});

getGetTrackDownloadQueryOptions(track.id, {
  request: tfRequestInit({ method: "GET" }),
});
```

Generated stream and download catches call `reportTfAuthError(error)` before their existing local reset/toast handling. Exact generated `unauthorized` invalidates the boundary, while `module_access_denied` and `policy_unavailable` force `/auth/me` revalidation.

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

Both provider logout mutations use `{ method: "POST" }`. Delete `useYandexSaveToken`, `/yandex/token` transport, and the disconnected token form. New Yandex onboarding remains deferred to server-side OAuth; existing server-backed status, catalog reads, and logout stay available. All provider GET calls preserve their existing query parameters and return types. Remove every HTTP use of `getClientSessionId`; leave only the pre-existing WebSocket reference for Task 4.

- [x] **Step 4: Run migration tests and the complete player suite**

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

- [x] **Step 1: Write failing lifecycle tests**

Use fake timers and injected dependencies to assert:

```ts
it("requests a fresh ticket before the initial socket");
it("requests a different fresh ticket before every reconnect");
it("uses a URL whose only query key is ticket");
it("backs off reconnects from 3000ms up to 30000ms");
it("does not reconnect after unauthenticated, forbidden, or unavailable ticket errors");
it("cancels pending ticket work and timers after stop");
it("classifies 4403/policy_revoked and 1013/policy_unavailable as terminal");
it("keeps 1013/buffer_unavailable reconnectable");
it("terminates a pre-open abnormal close without retrying indefinitely");
it("ignores captured stale handlers after stop/restart and replacement");
it("contains no runtime reference to getClientSessionId, X-Client-Session, trackfinder_session_id, sessionId query transport, or sid query transport");
```

Use a fake socket implementing `onopen`, `onmessage`, `onclose`, `onerror`, `readyState`, and `close()`. The ticket dependency returns ordered values such as `"a".repeat(43)` and `"b".repeat(43)` so reuse is observable.

- [x] **Step 2: Run the lifecycle test and verify RED**

Run:

```bash
pnpm --filter @workspace/music-player test -- src/lib/tf-websocket.test.ts
```

Expected: FAIL because `TfWebSocketLifecycle` does not exist.

- [x] **Step 3: Implement the isolated lifecycle**

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

`start()` is idempotent, increments an attempt generation, and starts `connect`. Every `onopen`, `onmessage`, `onerror`, and `onclose` wrapper verifies running state, generation, and socket ownership. Stop, close, replacement, and terminal transitions detach all four handlers before releasing ownership. `4403/policy_revoked` is terminal forbidden, `1013/policy_unavailable` is terminal unavailable, and `1013/buffer_unavailable` stays transient. Other closes before `onopen` terminate once as `websocket_unavailable`; that code forces auth/session revalidation, unmounts `PlayerProvider`, and creates a fresh lifecycle only after an accepted `/auth/me` response. Allowed post-open transient closes reconnect with a fresh ticket. `scheduleReconnect()` waits the current delay, doubles it with a `30000` cap, increments the generation, and calls `connect` so every attempt obtains a new ticket.

Move only socket creation/reconnect ownership out of `use-player.tsx`; retain its player-state message application and outgoing state serialization. Remove the final `getClientSessionId` import and delete `src/lib/client-session.ts`. Extend the migration test to scan all runtime `.ts`/`.tsx` files under `src`, excluding tests, and prove that no legacy identity transport remains. On terminal authentication/policy failure, forward the typed error into the auth channel, show one destructive toast, and leave reconnection stopped while the auth boundary revalidates and unmounts `PlayerProvider`.

- [x] **Step 4: Run lifecycle and player tests, typecheck, and commit**

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

- [x] **Step 1: Run the complete local validation matrix**

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

- [x] **Step 2: Run exact legacy and secret-boundary scans**

Run:

```bash
rg -n "getClientSessionId|X-Client-Session|trackfinder_session_id|[?&]sessionId=|[?&]sid=" artifacts/music-player/src
rg -n "Bearer |APOLLO_PLATFORM_CLIENT_SECRET|SPOTIFY_CLIENT_SECRET|YANDEX_TOKEN" artifacts/music-player/src
```

Expected: both commands produce no runtime matches.

- [x] **Step 3: Record implementation state**

Update `IMPLEMENTATION_STATUS.md` with:

```markdown
### TF web Platform session

- Status: implemented and locally validated
- Browser auth: Platform PKCE through `api.tf.apollot.ru`, host-only TF cookie
- CSRF: unmanaged `/api/auth/me` candidates never mutate security state; only the current provider generation commits a validated token for unsafe requests
- Policy: `tf.search` gates application mount; server remains authoritative for every capability
- WebSocket: one-time ticket acquired before every connection attempt
- Search: generated `searchTracks` receives credential/CSRF options at mutation time
- Generated media: stream/download auth and policy errors forward into the local auth channel before preserving existing user feedback
- Runtime invalidation: confirmed 401 and policy replacement synchronously unmount, cancel/clear protected queries, and clear CSRF before any revalidation
- Session commit: `/auth/me` success/error/malformed/transport outcomes never clear, commit, or publish; only a mounted current provider generation clears before refresh, decides typed failures, and commits CSRF
- Logout: remote POST starts with the current CSRF token, then local auth/query state clears immediately without waiting
- Yandex: new onboarding deferred to server-side OAuth; existing connected accounts retain server-backed reads and logout
- Legacy browser UUID: removed
- Remote infrastructure: unchanged; domains/Caddy/Coolify deployment still requires preflight and explicit approval
```

Mark only completed checkboxes in this plan and ensure `.superpowers/sdd/progress.md` keeps controller review/merge pending until it actually occurs.

- [x] **Step 4: Commit the release record**

Run:

```bash
git add IMPLEMENTATION_STATUS.md docs/superpowers/plans/2026-07-24-tf-web-session-integration.md
git commit -m "docs: record tf web session integration"
```

Expected: commit succeeds and `git status --short` is empty.

- [x] **Step 5: Independent final review and merge preparation**

Generate a whole-branch review package from merge base to HEAD. The final reviewer must return both `SPEC PASS` and `QUALITY APPROVED`; Critical and Important findings require one consolidated fix pass followed by re-review. After approval, merge the feature branch into `main`, rerun the Task 5 validation matrix on `main`, push both branch and `main`, and confirm both remote refs.
