import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createSignedBodySignature,
} from "@workspace/module-runtime-contract";
import { z } from "zod";

const PLATFORM_PATH = "/v1/internal/admin/overview";
const INTEGRATIONS_PATH = "/v1/internal/admin/connections";
const MAX_RESPONSE_BYTES = 128 * 1024;
const TIMEOUT_MS = 3_000;

const accountIdSchema = z.string().uuid();
const platformAccountSchema = z.object({
  id: accountIdSchema,
  email: z.string().email().max(320),
  displayName: z.string().trim().min(1).max(256),
  status: z.enum(["pending", "active", "suspended", "deleted"]),
  latestActivityAt: z.string().datetime({ offset: true }).optional(),
  activeSessionCount: z.number().int().nonnegative().max(1_000_000),
  moduleKeys: z.array(z.string().trim().min(1).max(128)).max(64),
}).strict();
const platformOverviewSchema = z.object({
  total: z.number().int().nonnegative().max(1_000_000_000),
  activeNow: z.number().int().nonnegative().max(1_000_000_000),
  pending: z.number().int().nonnegative().max(1_000_000_000),
  suspended: z.number().int().nonnegative().max(1_000_000_000),
  accounts: z.array(platformAccountSchema).max(100),
}).strict();
const integrationsOverviewSchema = z.object({
  connections: z.array(z.object({
    accountId: accountIdSchema,
    provider: z.enum(["spotify", "yandex"]),
    displayName: z.string().trim().min(1).max(500),
    updatedAt: z.string().datetime({ offset: true }),
  }).strict()).max(200),
}).strict();

type PlatformOverview = z.infer<typeof platformOverviewSchema>;
type IntegrationsOverview = z.infer<typeof integrationsOverviewSchema>;

export interface AdminPlatformOverviewGateway {
  load(): Promise<PlatformOverview>;
}

export interface AdminIntegrationsOverviewGateway {
  load(accountIds: readonly string[]): Promise<IntegrationsOverview>;
}

export interface AdminAccountOverview {
  readonly accountSummary: {
    readonly total: number;
    readonly activeNow: number;
    readonly pending: number;
    readonly suspended: number;
    readonly spotifyConnected: number;
    readonly yandexConnected: number;
  };
  readonly accounts: readonly (z.infer<typeof platformAccountSchema> & {
    readonly spotify: {
      readonly state: "connected" | "disconnected" | "unavailable";
      readonly displayName?: string;
      readonly updatedAt?: string;
    };
    readonly yandex: {
      readonly state: "connected" | "disconnected" | "unavailable";
      readonly displayName?: string;
      readonly updatedAt?: string;
    };
  })[];
}

export const unavailableAdminAccountOverview: AdminAccountOverview = Object.freeze({
  accountSummary: Object.freeze({
    total: 0,
    activeNow: 0,
    pending: 0,
    suspended: 0,
    spotifyConnected: 0,
    yandexConnected: 0,
  }),
  accounts: Object.freeze([]),
});

export async function createAdminAccountOverview(dependencies: {
  readonly platform: AdminPlatformOverviewGateway;
  readonly integrations: AdminIntegrationsOverviewGateway;
}): Promise<AdminAccountOverview> {
  const platform = platformOverviewSchema.parse(await dependencies.platform.load());
  let connections: IntegrationsOverview["connections"] | undefined;
  try {
    connections = integrationsOverviewSchema.parse(
      await dependencies.integrations.load(platform.accounts.map((account) => account.id)),
    ).connections;
  } catch {
    connections = undefined;
  }
  const connectionsByAccount = new Map(
    connections?.map((connection) => [`${connection.accountId}:${connection.provider}`, connection]) ?? [],
  );
  const connected = (accountId: string, provider: "spotify" | "yandex") => {
    if (connections === undefined) return { state: "unavailable" as const };
    const connection = connectionsByAccount.get(`${accountId}:${provider}`);
    return connection === undefined
      ? { state: "disconnected" as const }
      : {
          state: "connected" as const,
          displayName: connection.displayName,
          updatedAt: connection.updatedAt,
        };
  };
  const accounts = platform.accounts.map((account) => ({
    ...account,
    spotify: connected(account.id, "spotify"),
    yandex: connected(account.id, "yandex"),
  }));
  return {
    accountSummary: {
      total: platform.total,
      activeNow: platform.activeNow,
      pending: platform.pending,
      suspended: platform.suspended,
      spotifyConnected: accounts.filter((account) => account.spotify.state === "connected").length,
      yandexConnected: accounts.filter((account) => account.yandex.state === "connected").length,
    },
    accounts,
  };
}

export interface AdminAccountOverviewClientConfig {
  readonly platformOrigin: string;
  readonly platformClientId: string;
  readonly platformClientSecret: string;
  readonly integrationsOrigin: string;
  readonly integrationsSecret: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error("invalid runtime configuration");
  return value;
}

function privateOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.protocol !== "http:" ||
    !["platform-api", "tf-integrations", "localhost", "127.0.0.1"].includes(parsed.hostname)
  ) {
    throw new Error("invalid runtime configuration");
  }
  return parsed.origin;
}

async function secret(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length < 32 || value.length > 512) throw new Error("invalid runtime configuration");
  return value;
}

export async function parseAdminAccountOverviewClientConfig(
  env: NodeJS.ProcessEnv,
): Promise<AdminAccountOverviewClientConfig> {
  return {
    platformOrigin: privateOrigin(required(env, "APOLLO_PLATFORM_API_ORIGIN")),
    platformClientId: required(env, "APOLLO_TF_CLIENT_ID"),
    platformClientSecret: await secret(required(env, "APOLLO_TF_CLIENT_SECRET_FILE")),
    integrationsOrigin: privateOrigin(required(env, "TF_INTEGRATIONS_ORIGIN")),
    integrationsSecret: await secret(required(env, "TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE")),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new Error("overview unavailable");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new Error("overview unavailable");
  return JSON.parse(body) as unknown;
}

class SignedOverviewGateway {
  constructor(
    private readonly origin: string,
    private readonly secret: string,
    private readonly authorization?: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async post(path: string, body: unknown): Promise<unknown> {
    const rawBody = Buffer.from(JSON.stringify(body), "utf8");
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const nonce = randomBytes(32).toString("base64url");
    const signature = createSignedBodySignature({
      method: "POST",
      path,
      timestamp,
      nonce,
      rawBody,
      secret: this.secret,
    });
    const response = await this.fetchImplementation(new URL(path, this.origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        accept: "application/json",
        "accept-encoding": "identity",
        "content-type": "application/json",
        ...(this.authorization === undefined ? {} : { authorization: this.authorization }),
        "x-apollo-internal-timestamp": timestamp,
        "x-apollo-internal-nonce": nonce,
        "x-apollo-internal-signature": signature,
      },
      body: rawBody.toString("utf8"),
    });
    if (response.status !== 200) throw new Error("overview unavailable");
    return readJson(response);
  }
}

export class HttpAdminPlatformOverviewClient implements AdminPlatformOverviewGateway {
  readonly #gateway: SignedOverviewGateway;

  constructor(config: Pick<AdminAccountOverviewClientConfig, "platformOrigin" | "platformClientId" | "platformClientSecret">) {
    this.#gateway = new SignedOverviewGateway(
      config.platformOrigin,
      config.platformClientSecret,
      `Basic ${Buffer.from(`${config.platformClientId}:${config.platformClientSecret}`, "utf8").toString("base64")}`,
    );
  }

  async load(): Promise<PlatformOverview> {
    return platformOverviewSchema.parse(await this.#gateway.post(PLATFORM_PATH, {}));
  }
}

export class HttpAdminIntegrationsOverviewClient implements AdminIntegrationsOverviewGateway {
  readonly #gateway: SignedOverviewGateway;

  constructor(config: Pick<AdminAccountOverviewClientConfig, "integrationsOrigin" | "integrationsSecret">) {
    this.#gateway = new SignedOverviewGateway(config.integrationsOrigin, config.integrationsSecret);
  }

  async load(accountIds: readonly string[]): Promise<IntegrationsOverview> {
    return integrationsOverviewSchema.parse(
      await this.#gateway.post(INTEGRATIONS_PATH, { accountIds }),
    );
  }
}

export async function loadRuntimeAdminAccountOverview(
  env: NodeJS.ProcessEnv,
): Promise<AdminAccountOverview> {
  const config = await parseAdminAccountOverviewClientConfig(env);
  return createAdminAccountOverview({
    platform: new HttpAdminPlatformOverviewClient(config),
    integrations: new HttpAdminIntegrationsOverviewClient(config),
  });
}
