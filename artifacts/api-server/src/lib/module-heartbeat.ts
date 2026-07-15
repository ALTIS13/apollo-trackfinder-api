import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { HealthStatus } from "@workspace/admin-dashboard-contract";

const MODULE_IDS = [
  "public-web",
  "core-api",
  "account-integrations",
  "search-media",
  "download-worker",
  "postgresql",
  "redis",
  "queue-redis",
  "media-storage",
] as const;

const MODULE_ID_SET = new Set<string>(MODULE_IDS);
const MAX_CONFIGURED_MODULES = 128;
const MAX_NONCES = 128;
const NONCE_TTL_MS = 5 * 60_000;
const HEARTBEAT_FRESHNESS_MS = 90_000;
const TIMESTAMP_TOLERANCE_MS = 60_000;
const NONCE_PATTERN = /^[\x20-\x7e]{16,64}$/;
const CANONICAL_HEARTBEAT_PATH_PATTERN =
  /^\/api\/internal\/modules\/[a-z0-9]+(?:-[a-z0-9]+)*\/heartbeat$/;
const DUMMY_SECRET = randomBytes(32).toString("hex");

const moduleHeartbeatPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["healthy", "warning", "degraded", "unknown"]),
    version: z.string().trim().min(1).max(128),
    deployedAt: z.string().datetime({ offset: true }).optional(),
    requestsPerMinute: z.number().finite().min(0).max(1_000_000).optional(),
  })
  .strict();

const heartbeatKeysSchema = z.record(z.string(), z.string().min(32).max(512));

export interface SignatureInput {
  moduleId: string;
  timestamp: string;
  nonce: string;
  rawBody: Buffer;
  secret: string;
}

export interface ModuleHeartbeatIngestInput {
  moduleId: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  rawBody: Buffer;
}

export interface ModuleHeartbeatObservation {
  moduleId: string;
  managed: boolean;
  status: HealthStatus;
  version: string;
  deployedAt?: string;
  lastHeartbeatAt?: string;
  requestsPerMinute: number;
}

export type ModuleHeartbeatIngestResult =
  | { kind: "accepted"; receivedAt: string }
  | { kind: "disabled" }
  | { kind: "unauthorized" }
  | { kind: "invalid" }
  | { kind: "stale" };

export interface ModuleHeartbeatServiceOptions {
  keys: ReadonlyMap<string, string>;
  now?: () => number;
  monotonicNow?: () => number;
}

interface AcceptedHeartbeat {
  signedAt: number;
  receivedAt: number;
  receivedMonotonicAt: number;
  status: HealthStatus;
  version: string;
  deployedAt?: string;
  requestsPerMinute: number;
}

export function createModuleHeartbeatSignature(input: SignatureInput): string {
  const bodyHash = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "POST",
    `/api/internal/modules/${input.moduleId}/heartbeat`,
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
  return `v1=${createHmac("sha256", input.secret).update(canonical).digest("hex")}`;
}

export function isCanonicalModuleHeartbeatPath(path: string): boolean {
  return CANONICAL_HEARTBEAT_PATH_PATTERN.test(path);
}

export function parseModuleHeartbeatKeys(
  raw: string | undefined,
): Map<string, string> {
  if (raw === undefined) return new Map();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length > MAX_CONFIGURED_MODULES
    ) {
      return new Map();
    }

    const configured = heartbeatKeysSchema.safeParse(parsed);
    if (!configured.success) return new Map();

    const entries = Object.entries(configured.data);
    if (entries.some(([moduleId]) => !MODULE_ID_SET.has(moduleId))) {
      return new Map();
    }

    return new Map(entries);
  } catch {
    return new Map();
  }
}

function hasMatchingSignature(
  providedSignature: string | undefined,
  expectedSignature: string,
): boolean {
  const providedDigest = createHash("sha256")
    .update(providedSignature ?? "")
    .digest();
  const expectedDigest = createHash("sha256")
    .update(expectedSignature)
    .digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function parseSignedTimestamp(timestamp: string): number | undefined {
  if (!/^\d+$/.test(timestamp)) return undefined;
  const signedSeconds = Number(timestamp);
  if (!Number.isSafeInteger(signedSeconds)) return undefined;
  const signedAt = signedSeconds * 1_000;
  return Number.isSafeInteger(signedAt) ? signedAt : undefined;
}

export class ModuleHeartbeatService {
  private readonly keys: Map<string, string>;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly heartbeats = new Map<string, AcceptedHeartbeat>();
  private nonces = new Map<string, Map<string, number>>();

  constructor(options: ModuleHeartbeatServiceOptions) {
    this.keys = new Map(
      Array.from(options.keys).filter(([moduleId]) =>
        MODULE_ID_SET.has(moduleId),
      ),
    );
    this.now = options.now ?? Date.now;
    this.monotonicNow =
      options.monotonicNow ?? performance.now.bind(performance);
  }

  ingest(input: ModuleHeartbeatIngestInput): ModuleHeartbeatIngestResult {
    if (this.keys.size === 0) return { kind: "disabled" };

    const moduleId = input.moduleId;
    const timestamp = input.timestamp ?? "";
    const nonce = input.nonce ?? "";
    const rawBody = Buffer.isBuffer(input.rawBody)
      ? input.rawBody
      : Buffer.alloc(0);
    const secret = this.keys.get(moduleId) ?? DUMMY_SECRET;
    const expectedSignature = createModuleHeartbeatSignature({
      moduleId,
      timestamp,
      nonce,
      rawBody,
      secret,
    });

    if (
      !hasMatchingSignature(input.signature, expectedSignature) ||
      !this.keys.has(moduleId)
    ) {
      return { kind: "unauthorized" };
    }

    const signedAt = parseSignedTimestamp(timestamp);
    if (signedAt === undefined || !NONCE_PATTERN.test(nonce)) {
      return { kind: "unauthorized" };
    }

    const receivedAt = this.now();
    if (Math.abs(receivedAt - signedAt) > TIMESTAMP_TOLERANCE_MS) {
      return { kind: "unauthorized" };
    }
    const receivedMonotonicAt = this.monotonicNow();

    const liveNonces = new Map(
      Array.from(this.nonces.get(moduleId) ?? []).filter(
        ([, recordedAt]) => receivedMonotonicAt - recordedAt <= NONCE_TTL_MS,
      ),
    );
    if (liveNonces.has(nonce) || liveNonces.size >= MAX_NONCES) {
      return { kind: "unauthorized" };
    }

    const previousHeartbeat = this.heartbeats.get(moduleId);
    if (
      previousHeartbeat !== undefined &&
      signedAt < previousHeartbeat.signedAt
    ) {
      return { kind: "stale" };
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { kind: "invalid" };
    }

    const payload = moduleHeartbeatPayloadSchema.safeParse(parsedBody);
    if (!payload.success) return { kind: "invalid" };

    liveNonces.set(nonce, receivedMonotonicAt);
    this.nonces.set(moduleId, liveNonces);
    this.heartbeats.set(moduleId, {
      signedAt,
      receivedAt,
      receivedMonotonicAt,
      status: payload.data.status,
      version: payload.data.version,
      ...(payload.data.deployedAt === undefined
        ? {}
        : { deployedAt: payload.data.deployedAt }),
      requestsPerMinute: payload.data.requestsPerMinute ?? 0,
    });

    return { kind: "accepted", receivedAt: new Date(receivedAt).toISOString() };
  }

  snapshot(at = this.monotonicNow()): ModuleHeartbeatObservation[] {
    return Array.from(this.keys.keys(), (moduleId) => {
      const heartbeat = this.heartbeats.get(moduleId);
      if (heartbeat === undefined) {
        return {
          moduleId,
          managed: true,
          status: "unknown",
          version: "unknown",
          requestsPerMinute: 0,
        };
      }

      const fresh =
        at - heartbeat.receivedMonotonicAt <= HEARTBEAT_FRESHNESS_MS;
      return {
        moduleId,
        managed: true,
        status: fresh ? heartbeat.status : "unknown",
        version: heartbeat.version,
        ...(heartbeat.deployedAt === undefined
          ? {}
          : { deployedAt: heartbeat.deployedAt }),
        lastHeartbeatAt: new Date(heartbeat.receivedAt).toISOString(),
        requestsPerMinute: fresh ? heartbeat.requestsPerMinute : 0,
      };
    });
  }
}

export const moduleHeartbeatService = new ModuleHeartbeatService({
  keys: parseModuleHeartbeatKeys(process.env["APOLLO_MODULE_HEARTBEAT_KEYS"]),
});
