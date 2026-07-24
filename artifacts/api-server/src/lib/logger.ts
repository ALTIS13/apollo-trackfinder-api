import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
  type LogFn,
} from "pino";

const REDACTED = "[REDACTED]";
const MAX_SANITIZE_DEPTH = 32;
const MAX_SANITIZE_NODES = 10_000;
const SENSITIVE_FIELD_NAMES = new Set(
  [
    "authorization",
    "cookie",
    "cookies",
    "setcookie",
    "session",
    "sessionid",
    "sessiontoken",
    "rawsessiontoken",
    "platformsessionid",
    "tfsession",
    "transaction",
    "transactionhandle",
    "tx",
    "ticket",
    "websocketticket",
    "assertion",
    "accesstoken",
    "code",
    "state",
    "verifier",
    "codeverifier",
    "codechallenge",
    "nonce",
    "clientsecret",
    "clientsecretdigest",
    "rawclientsecret",
    "basicauthorization",
    "jwk",
    "jwks",
    "rediskey",
    "redispayload",
    "upstreambody",
    "responsebody",
    "body",
    "err",
    "error",
    "errortext",
    "text",
    "tojson",
    "serializer",
  ].map(normalizeFieldName),
);

interface SanitizeState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function normalizeFieldName(field: string): string {
  return field.toLowerCase().replace(/[-_.]/g, "");
}

function sanitizeLoggingValue(
  value: unknown,
  state: SanitizeState,
  depth = 0,
): unknown {
  if (typeof value === "function") return "[Function]";
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return "[Binary]";
  }
  if (depth >= MAX_SANITIZE_DEPTH || state.nodes >= MAX_SANITIZE_NODES) {
    return "[Truncated]";
  }
  if (state.ancestors.has(value)) return "[Circular]";

  state.nodes += 1;
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, MAX_SANITIZE_NODES);
      const sanitized = new Array<unknown>(length);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        sanitized[index] =
          descriptor !== undefined && "value" in descriptor
            ? sanitizeLoggingValue(descriptor.value, state, depth + 1)
            : "[Accessor]";
      }
      if (value.length > length) sanitized.push("[Truncated]");
      return sanitized;
    }

    const sanitized: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (SENSITIVE_FIELD_NAMES.has(normalizeFieldName(key))) {
        sanitized[key] = REDACTED;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      sanitized[key] =
        descriptor !== undefined && "value" in descriptor
          ? sanitizeLoggingValue(descriptor.value, state, depth + 1)
          : "[Accessor]";
    }
    return sanitized;
  } finally {
    state.ancestors.delete(value);
  }
}

function sanitizeLogObject(value: object): Record<string, unknown> {
  try {
    return sanitizeLoggingValue(value, {
      ancestors: new WeakSet(),
      nodes: 0,
    }) as Record<string, unknown>;
  } catch {
    return { logSanitization: REDACTED };
  }
}

export function createTfLogger(destination?: DestinationStream): Logger {
  const isProduction = process.env.NODE_ENV === "production";
  const options: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? "info",
    hooks: {
      logMethod(arguments_, method) {
        const sanitized = arguments_.map((argument) =>
          typeof argument === "object" && argument !== null
            ? sanitizeLogObject(argument)
            : argument,
        );
        method.apply(this, sanitized as Parameters<LogFn>);
      },
    },
    redact: {
      censor: REDACTED,
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers['x-admin-dashboard-token']",
        "req.headers['x-apollo-heartbeat-signature']",
        "req.headers['x-apollo-heartbeat-timestamp']",
        "req.headers['x-apollo-heartbeat-nonce']",
        "res.headers['set-cookie']",
      ],
    },
    ...(isProduction || destination !== undefined
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true },
          },
        }),
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export const logger = createTfLogger();
