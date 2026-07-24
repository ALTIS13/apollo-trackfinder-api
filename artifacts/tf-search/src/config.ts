import { readFile } from "node:fs/promises";
import { z } from "zod";

export interface TfSearchRuntimeConfig {
  readonly port: number;
  readonly internalAuthSecret: string;
  readonly heartbeatSecret: string;
  readonly heartbeatApiOrigin: string;
  readonly version: string;
  readonly deployedAt?: string;
}

type SecretReader = (path: string) => Promise<string>;

const secretSchema = z.string().min(32).max(512);
const deployedAtSchema = z.string().datetime({ offset: true });
const privateServiceNamePattern = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalidConfiguration(): never {
  throw new Error("invalid runtime configuration");
}

function readRequiredValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? invalidConfiguration() : value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) return invalidConfiguration();
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535
    ? port
    : invalidConfiguration();
}

function isPrivateHttpHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") {
    return true;
  }
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split(".").every((part) => Number(part) <= 255);
  }
  return privateServiceNamePattern.test(hostname);
}

function parseApiOrigin(
  value: string,
  allowInsecureHttp: boolean,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidConfiguration();
  }

  if (value !== parsed.origin || parsed.username !== "" || parsed.password !== "") {
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

async function loadSecret(
  env: NodeJS.ProcessEnv,
  name: string,
  readSecret: SecretReader,
): Promise<string> {
  const path = readRequiredValue(env, name);
  try {
    const secret = (await readSecret(path)).trim();
    return secretSchema.safeParse(secret).success ? secret : invalidConfiguration();
  } catch {
    return invalidConfiguration();
  }
}

export async function parseTfSearchRuntimeConfig(
  env: NodeJS.ProcessEnv,
  readSecret: SecretReader = (path) => readFile(path, "utf8"),
): Promise<TfSearchRuntimeConfig> {
  const port = parsePort(readRequiredValue(env, "PORT"));
  const [internalAuthSecret, heartbeatSecret] = await Promise.all([
    loadSecret(env, "TF_SEARCH_INTERNAL_AUTH_SECRET_FILE", readSecret),
    loadSecret(env, "TF_SEARCH_HEARTBEAT_SECRET_FILE", readSecret),
  ]);
  if (internalAuthSecret === heartbeatSecret) return invalidConfiguration();

  const heartbeatApiOrigin = parseApiOrigin(
    readRequiredValue(env, "TF_SEARCH_HEARTBEAT_API_ORIGIN"),
    env["TF_SEARCH_HEARTBEAT_ALLOW_INSECURE_HTTP"] === "true",
  );
  const version = env["APOLLO_API_VERSION"]?.trim() || "unknown";
  if (version.length > 128) return invalidConfiguration();

  const deployedAt = env["APOLLO_DEPLOYED_AT"]?.trim();
  if (deployedAt !== undefined && !deployedAtSchema.safeParse(deployedAt).success) {
    return invalidConfiguration();
  }

  return {
    port,
    internalAuthSecret,
    heartbeatSecret,
    heartbeatApiOrigin,
    version,
    ...(deployedAt === undefined ? {} : { deployedAt }),
  };
}
