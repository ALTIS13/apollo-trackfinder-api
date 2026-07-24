import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
  type LogFn,
} from "pino";

export interface PlatformLogger {
  info(object: Record<string, unknown>, message?: string): void;
  error(object: Record<string, unknown>, message?: string): void;
}

const SENSITIVE_FIELDS = [
  "authorization",
  "cookie",
  "cookies",
  "password",
  "token",
  "bootstrapToken",
  "rawToken",
  "verificationToken",
  "invitationToken",
  "code",
  "state",
  "assertion",
  "access_token",
  "code_verifier",
  "codeVerifier",
  "nonce",
  "d",
  "clientSecret",
  "client_secret",
  "clientSecretDigest",
  "client_secret_digest",
  "secretDigest",
  "rawClientSecret",
  "clientSecretSha256",
  "client_secret_sha256",
  "sessionToken",
  "session_token",
  "rawSessionToken",
  "raw_session_token",
  "set-cookie",
] as const;

const REDACTED = "[REDACTED]";
const MAX_SANITIZE_DEPTH = 32;
const MAX_SANITIZE_NODES = 10_000;
const SENSITIVE_FIELD_NAMES = new Set(
  SENSITIVE_FIELDS.map((field) => field.toLowerCase()),
);

interface SanitizeState {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function sanitizeLoggingValue(
  value: unknown,
  state: SanitizeState,
  depth = 0,
): unknown {
  if (typeof value === "function") return "[Function]";
  if (typeof value !== "object" || value === null) return value;
  if (depth >= MAX_SANITIZE_DEPTH || state.nodes >= MAX_SANITIZE_NODES) {
    return "[Truncated]";
  }
  if (state.ancestors.has(value)) return "[Circular]";

  state.nodes += 1;
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((_item, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        return descriptor !== undefined && "value" in descriptor
          ? sanitizeLoggingValue(descriptor.value, state, depth + 1)
          : "[Accessor]";
      });
    }

    const sanitized: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
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

export function createPlatformLogger(destination?: DestinationStream): Logger {
  const paths = [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers.set-cookie",
    ...SENSITIVE_FIELDS,
    ...SENSITIVE_FIELDS.map((field) => `*.${field}`),
    ...SENSITIVE_FIELDS.map((field) => `*.*.${field}`),
  ];
  const options: LoggerOptions = {
    hooks: {
      logMethod(arguments_, method) {
        const [first, ...remaining] = arguments_;
        if (typeof first === "object" && first !== null) {
          method.apply(this, [
            sanitizeLogObject(first),
            ...remaining,
          ] as Parameters<LogFn>);
          return;
        }
        method.apply(this, arguments_);
      },
    },
    redact: {
      censor: REDACTED,
      paths,
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
