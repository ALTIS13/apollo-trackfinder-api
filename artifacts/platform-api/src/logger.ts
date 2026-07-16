import pino, { type Logger } from "pino";

export interface PlatformLogger {
  info(object: Record<string, unknown>, message?: string): void;
  error(object: Record<string, unknown>, message?: string): void;
}

export function createPlatformLogger(): Logger {
  return pino({
    redact: {
      censor: "[REDACTED]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "authorization",
        "cookie",
        "password",
        "token",
        "bootstrapToken",
        "rawToken",
        "verificationToken",
        "invitationToken",
        "*.password",
        "*.token",
        "*.bootstrapToken",
      ],
    },
  });
}
