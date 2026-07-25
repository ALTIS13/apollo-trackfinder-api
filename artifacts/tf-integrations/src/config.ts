import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

import {
  parseProviderTokenKeyring,
  type ProviderTokenKeyring,
} from "./token-keyring.js";

export interface TfIntegrationsConfig {
  readonly port: number;
  readonly internalAuthSecret: string;
  readonly heartbeatSecret: string;
  readonly databaseUrl: string;
  readonly tokenKeyring: ProviderTokenKeyring;
  readonly spotifyClientId: string;
  readonly spotifyClientSecret: string;
  readonly spotifyCallbackUri: string;
  readonly heartbeatApiOrigin: string;
  readonly version: string;
  readonly deployedAt?: string;
  readonly smokeFixtures: boolean;
}

type SecretReader = (path: string) => Promise<string>;

const privateServiceNamePattern = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const deployedAtPattern =
  /^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function invalidConfiguration(): never {
  throw new Error("invalid runtime configuration");
}

function requiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0
    ? invalidConfiguration()
    : value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) return invalidConfiguration();
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : invalidConfiguration();
}

function isPrivateHttpHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (/^127(?:\.\d{1,3}){3}$/.test(hostname) &&
      hostname.split(".").every((part) => Number(part) <= 255)) ||
    privateServiceNamePattern.test(hostname)
  );
}

function exactOrigin(value: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidConfiguration();
  }
  if (
    value !== parsed.origin ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return invalidConfiguration();
  }
  if (parsed.protocol === "https:") return parsed.origin;
  if (
    parsed.protocol === "http:" &&
    allowInsecureHttp &&
    isPrivateHttpHostname(parsed.hostname)
  ) {
    return parsed.origin;
  }
  return invalidConfiguration();
}

function exactSpotifyCallback(value: string): string {
  try {
    const parsed = new URL(value);
    const canonical = `${parsed.origin}/api/spotify/callback`;
    if (
      value.length <= 4_096 &&
      value === canonical &&
      parsed.protocol === "https:" &&
      parsed.pathname === "/api/spotify/callback" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === ""
    ) {
      return value;
    }
  } catch {
    // Report every malformed callback through the generic config error.
  }
  return invalidConfiguration();
}

function parseAllowInsecureHttp(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value === "true" ? true : invalidConfiguration();
}

function parseSmokeFixtures(env: NodeJS.ProcessEnv): boolean {
  const value = env["TF_INTEGRATIONS_SMOKE_FIXTURES"];
  if (value === undefined) return false;
  return value === "true" && env["NODE_ENV"] === "test"
    ? true
    : invalidConfiguration();
}

async function loadFile(
  env: NodeJS.ProcessEnv,
  name: string,
  readSecret: SecretReader,
  minimumLength: number,
  maximumLength: number,
): Promise<string> {
  try {
    const value = (await readSecret(requiredValue(env, name))).trim();
    return value.length >= minimumLength && value.length <= maximumLength
      ? value
      : invalidConfiguration();
  } catch {
    return invalidConfiguration();
  }
}

function parseDatabaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (
      value.length <= 8_192 &&
      (parsed.protocol === "postgres:" || parsed.protocol === "postgresql:") &&
      parsed.hostname.length > 0 &&
      parsed.pathname.length > 1 &&
      parsed.search === "" &&
      parsed.hash === ""
    ) {
      return value;
    }
  } catch {
    // Report malformed database material without reflecting it.
  }
  return invalidConfiguration();
}

function parseDeployedAt(value: string | undefined): string | undefined {
  const deployedAt = value?.trim();
  if (deployedAt === undefined || deployedAt.length === 0) return undefined;
  if (
    deployedAt.length <= 128 &&
    deployedAtPattern.test(deployedAt) &&
    Number.isFinite(Date.parse(deployedAt))
  ) {
    return deployedAt;
  }
  return invalidConfiguration();
}

async function defaultSecretReader(path: string): Promise<string> {
  const bytes = await readFile(path);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function loadTfIntegrationsDatabaseUrl(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader = defaultSecretReader,
): Promise<string> {
  return parseDatabaseUrl(
    await loadFile(
      env,
      "TF_INTEGRATIONS_DATABASE_URL_FILE",
      readSecret,
      1,
      8_192,
    ),
  );
}

export async function parseTfIntegrationsConfig(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader = defaultSecretReader,
): Promise<TfIntegrationsConfig> {
  const port = parsePort(requiredValue(env, "PORT"));
  const [
    internalAuthSecret,
    heartbeatSecret,
    rawDatabaseUrl,
    rawTokenKeyring,
    spotifyClientId,
    spotifyClientSecret,
  ] = await Promise.all([
    loadFile(
      env,
      "TF_INTEGRATIONS_INTERNAL_AUTH_SECRET_FILE",
      readSecret,
      32,
      512,
    ),
    loadFile(env, "TF_INTEGRATIONS_HEARTBEAT_SECRET_FILE", readSecret, 32, 512),
    loadFile(env, "TF_INTEGRATIONS_DATABASE_URL_FILE", readSecret, 1, 8_192),
    loadFile(env, "TF_INTEGRATIONS_TOKEN_KEYRING_FILE", readSecret, 1, 4_096),
    loadFile(
      env,
      "TF_INTEGRATIONS_SPOTIFY_CLIENT_ID_FILE",
      readSecret,
      1,
      8_192,
    ),
    loadFile(
      env,
      "TF_INTEGRATIONS_SPOTIFY_CLIENT_SECRET_FILE",
      readSecret,
      1,
      8_192,
    ),
  ]);
  if (internalAuthSecret === heartbeatSecret) return invalidConfiguration();

  let tokenKeyring: ProviderTokenKeyring;
  try {
    tokenKeyring = parseProviderTokenKeyring(rawTokenKeyring);
  } catch {
    return invalidConfiguration();
  }
  const databaseUrl = parseDatabaseUrl(rawDatabaseUrl);
  const spotifyCallbackUri = exactSpotifyCallback(
    requiredValue(env, "TF_INTEGRATIONS_SPOTIFY_CALLBACK_URI"),
  );
  const heartbeatApiOrigin = exactOrigin(
    requiredValue(env, "TF_INTEGRATIONS_HEARTBEAT_API_ORIGIN"),
    parseAllowInsecureHttp(
      env["TF_INTEGRATIONS_HEARTBEAT_ALLOW_INSECURE_HTTP"],
    ),
  );
  const version = requiredValue(env, "APOLLO_API_VERSION");
  if (version.length > 128) return invalidConfiguration();
  const deployedAt = parseDeployedAt(env["APOLLO_DEPLOYED_AT"]);
  const smokeFixtures = parseSmokeFixtures(env);

  return {
    port,
    internalAuthSecret,
    heartbeatSecret,
    databaseUrl,
    tokenKeyring,
    spotifyClientId,
    spotifyClientSecret,
    spotifyCallbackUri,
    heartbeatApiOrigin,
    version,
    ...(deployedAt === undefined ? {} : { deployedAt }),
    smokeFixtures,
  };
}
