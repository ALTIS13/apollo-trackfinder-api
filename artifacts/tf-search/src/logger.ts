import pino, {
  type DestinationStream,
  type Logger,
  type LoggerOptions,
  type LogFn,
} from "pino";

const REDACTED = "[REDACTED]";
const sensitiveKeyPattern = /(?:query|artist|title|url|body|header|signature|timestamp|nonce|error|token|secret|cookie|authorization)/i;

function sanitize(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key !== undefined && sensitiveKeyPattern.test(key)) return REDACTED;
  if (value instanceof Error || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return REDACTED;
  }
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, undefined, seen));
    const result: Record<string, unknown> = {};
    for (const property of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      result[property] =
        descriptor === undefined || !("value" in descriptor)
          ? REDACTED
          : sanitize(descriptor.value, property, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function sanitizeBinding(bindings: object): Record<string, unknown> {
  return sanitize(bindings) as Record<string, unknown>;
}

export function createTfSearchLogger(destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: process.env["LOG_LEVEL"] ?? "info",
    hooks: {
      logMethod(arguments_, method) {
        const sanitized = arguments_.map((argument) =>
          typeof argument === "object" && argument !== null
            ? sanitize(argument)
            : argument,
        );
        method.apply(this, sanitized as Parameters<LogFn>);
      },
    },
    formatters: {
      bindings(bindings) {
        return sanitizeBinding(bindings);
      },
    },
    serializers: {
      err: () => REDACTED,
      req: () => REDACTED,
      res: () => REDACTED,
    },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export const logger = createTfSearchLogger();
