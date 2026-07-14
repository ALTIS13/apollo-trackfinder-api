import { z } from "zod";
import type { DashboardSnapshot } from "../types/dashboard";

const idSchema = z.string().trim().min(1).max(128);
const labelSchema = z.string().trim().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });
const finiteNumberSchema = z.number().finite();
const nonNegativeNumberSchema = finiteNumberSchema.nonnegative();
const nonNegativeIntegerSchema = z.number().int().nonnegative().finite();
const healthStatusSchema = z.enum(["healthy", "warning", "degraded", "unknown"]);

const metricSchema = z.object({
  id: idSchema,
  label: labelSchema,
  value: z.string().max(128),
  change: z.string().max(128),
  trend: z.array(finiteNumberSchema).max(128),
}).strict();

const moduleSchema = z.object({
  id: idSchema,
  name: labelSchema,
  status: healthStatusSchema,
  version: z.string().trim().min(1).max(128),
  availableVersion: z.string().trim().min(1).max(128).optional(),
  lastDeploymentAt: timestampSchema,
  requestsPerMinute: nonNegativeNumberSchema,
}).strict();

const edgeSchema = z.object({
  id: idSchema,
  source: idSchema,
  target: idSchema,
  status: healthStatusSchema,
  requestsPerMinute: nonNegativeNumberSchema,
}).strict();

const incidentSchema = z.object({
  id: idSchema,
  title: labelSchema,
  severity: z.enum(["critical", "warning", "info"]),
  status: z.enum(["open", "acknowledged", "resolved"]),
  serviceId: idSchema,
  createdAt: timestampSchema,
}).strict();

const providerSchema = z.object({
  id: idSchema,
  name: labelSchema,
  status: healthStatusSchema,
  latencyMs: nonNegativeIntegerSchema,
  latencyTrendMs: z.array(nonNegativeIntegerSchema).max(128),
  lastCheckedAt: timestampSchema,
}).strict();

const dashboardSnapshotSchema = z.object({
  generatedAt: timestampSchema,
  metrics: z.array(metricSchema).max(32),
  modules: z.array(moduleSchema).max(128),
  edges: z.array(edgeSchema).max(512),
  incidents: z.array(incidentSchema).max(512),
  providers: z.array(providerSchema).max(128),
}).strict().superRefine((snapshot, context) => {
  const moduleIds = new Set<string>();
  snapshot.modules.forEach((module, index) => {
    if (moduleIds.has(module.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate service ID: ${module.id}`,
        path: ["modules", index, "id"],
      });
    }
    moduleIds.add(module.id);
  });

  const incidentIds = new Set<string>();
  snapshot.incidents.forEach((incident, index) => {
    if (incidentIds.has(incident.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate incident ID: ${incident.id}`,
        path: ["incidents", index, "id"],
      });
    }
    incidentIds.add(incident.id);
    if (!moduleIds.has(incident.serviceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown incident service: ${incident.serviceId}`,
        path: ["incidents", index, "serviceId"],
      });
    }
  });

  snapshot.edges.forEach((edge, index) => {
    if (!moduleIds.has(edge.source)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown edge source: ${edge.source}`,
        path: ["edges", index, "source"],
      });
    }
    if (!moduleIds.has(edge.target)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown edge target: ${edge.target}`,
        path: ["edges", index, "target"],
      });
    }
  });
});

export function parseDashboardSnapshot(value: unknown): DashboardSnapshot {
  const result = dashboardSnapshotSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "snapshot"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid admin dashboard snapshot: ${details}`);
  }
  return result.data;
}
