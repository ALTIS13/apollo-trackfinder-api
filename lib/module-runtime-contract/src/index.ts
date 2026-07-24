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
  .regex(/^[A-Za-z0-9_-]{43}$/);

const moduleHeartbeatPayloadObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["healthy", "warning", "degraded", "unknown"]),
    version: z.string().trim().min(1).max(128),
    deployedAt: z.string().datetime({ offset: true }).optional(),
    requestsPerMinute: z.number().finite().min(0).max(1_000_000).optional(),
  })
  .strict();

export type ModuleHeartbeatPayload = z.infer<
  typeof moduleHeartbeatPayloadObjectSchema
>;

export const moduleHeartbeatPayloadSchema: z.ZodType<ModuleHeartbeatPayload> =
  moduleHeartbeatPayloadObjectSchema;

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
  const providedDigest = createHash("sha256").update(provided ?? "").digest();
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
