import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export interface SignedBodyInput {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly rawBody: Uint8Array;
  readonly secret: string;
}

export interface SignatureInput {
  readonly moduleId: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly rawBody: Uint8Array;
  readonly secret: string;
}

export const canonicalNonceSchema: z.ZodString = z
  .string()
  // A 43-character base64url encoding of 32 bytes has two zero pad bits in its final character.
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

const moduleHealthStatusSchema = z.enum([
  "healthy",
  "warning",
  "degraded",
  "unknown",
]);
const parserTelemetrySchema = z
  .object({
    source: z.enum(["yt", "sc", "bc", "dz"]),
    status: moduleHealthStatusSchema,
    requestsPerMinute: z.number().finite().int().min(0).max(1_000_000),
    failuresPerMinute: z.number().finite().int().min(0).max(1_000_000),
    previewsRejectedPerMinute: z
      .number()
      .finite()
      .int()
      .min(0)
      .max(1_000_000),
    lastCheckedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const parserTelemetryListSchema = z
  .array(parserTelemetrySchema)
  .max(4)
  .refine(
    (parsers) =>
      new Set(parsers.map((parser) => parser.source)).size === parsers.length,
    { message: "Parser telemetry sources must be unique" },
  );

const moduleHeartbeatPayloadObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: moduleHealthStatusSchema,
    version: z.string().trim().min(1).max(128),
    deployedAt: z.string().datetime({ offset: true }).optional(),
    requestsPerMinute: z.number().finite().min(0).max(1_000_000).optional(),
    parsers: parserTelemetryListSchema.optional(),
  })
  .strict();

export type ModuleHeartbeatPayload = z.infer<
  typeof moduleHeartbeatPayloadObjectSchema
>;
export type ModuleParserTelemetry = z.infer<typeof parserTelemetrySchema>;

export const moduleHeartbeatPayloadSchema: z.ZodType<ModuleHeartbeatPayload> =
  moduleHeartbeatPayloadObjectSchema;

export function isValidModuleHeartbeatSecret(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const byteLength = new TextEncoder().encode(value).byteLength;
  return byteLength >= 32 && byteLength <= 512;
}

export function createSignedBodySignature(input: SignedBodyInput): string {
  const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

export function hasMatchingSignedBodySignature(
  provided: string | undefined,
  expected: string,
): boolean {
  const providedDigest = createHash("sha256")
    .update(provided ?? "")
    .digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function createModuleHeartbeatSignature(input: SignatureInput): string {
  return createSignedBodySignature({
    method: "POST",
    path: `/api/internal/modules/${input.moduleId}/heartbeat`,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
    secret: input.secret,
  });
}
