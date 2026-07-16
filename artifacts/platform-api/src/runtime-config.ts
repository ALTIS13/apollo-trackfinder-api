export interface PlatformRuntimeConfig {
  readonly allowedOrigins: readonly string[];
  readonly databaseUrl: string;
  readonly developmentTokenEcho: boolean;
  readonly nodeEnv: string;
  readonly operatorBootstrapToken: string;
  readonly port: number;
  readonly redisUrl: string;
  readonly trustProxyHops: number;
}

function requiredEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured`);
  }
  return value;
}

function configuredOrigins(value: string): readonly string[] {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.length === 0) {
    throw new Error("APOLLO_ALLOWED_ORIGINS must not be empty");
  }
  for (const origin of origins) {
    try {
      if (new URL(origin).origin !== origin) {
        throw new Error();
      }
    } catch {
      throw new Error("APOLLO_ALLOWED_ORIGINS entries must be exact origins");
    }
  }
  return Object.freeze([...new Set(origins)]);
}

function configuredPort(environment: NodeJS.ProcessEnv): number {
  const value = environment.PORT ?? "3000";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be a valid TCP port");
  }
  return port;
}

function configuredTrustProxyHops(environment: NodeJS.ProcessEnv): number {
  const value = environment.APOLLO_TRUST_PROXY_HOPS ?? "0";
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 2) {
    throw new Error("APOLLO_TRUST_PROXY_HOPS must be an integer from 0 to 2");
  }
  return hops;
}

export function parsePlatformRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): PlatformRuntimeConfig {
  const nodeEnv = environment.NODE_ENV ?? "development";
  const developmentTokenEcho =
    environment.APOLLO_DEVELOPMENT_TOKEN_ECHO === "true";
  if (nodeEnv === "production" && developmentTokenEcho) {
    throw new Error(
      "APOLLO_DEVELOPMENT_TOKEN_ECHO is prohibited in production",
    );
  }

  return Object.freeze({
    allowedOrigins: configuredOrigins(
      requiredEnvironment(environment, "APOLLO_ALLOWED_ORIGINS"),
    ),
    databaseUrl: requiredEnvironment(environment, "DATABASE_URL"),
    developmentTokenEcho,
    nodeEnv,
    operatorBootstrapToken: requiredEnvironment(
      environment,
      "APOLLO_OPERATOR_BOOTSTRAP_TOKEN",
    ),
    port: configuredPort(environment),
    redisUrl: requiredEnvironment(environment, "APOLLO_REDIS_URL"),
    trustProxyHops: configuredTrustProxyHops(environment),
  });
}
