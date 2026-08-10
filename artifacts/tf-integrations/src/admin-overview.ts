import { z } from "zod";

import type {
  AdminConnectionSummaryRepository,
} from "@workspace/tf-integrations-db";

const accountIdSchema = z.string().uuid();

export const TF_INTEGRATIONS_ADMIN_OVERVIEW_PATH =
  "/v1/internal/admin/connections";

export const integrationsAdminOverviewRequestSchema = z
  .object({ accountIds: z.array(accountIdSchema).max(100) })
  .strict()
  .superRefine(({ accountIds }, context) => {
    if (new Set(accountIds).size !== accountIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "accountIds must be unique",
        path: ["accountIds"],
      });
    }
  });

export const integrationsAdminOverviewResponseSchema = z
  .object({
    connections: z
      .array(
        z
          .object({
            accountId: accountIdSchema,
            provider: z.enum(["spotify", "yandex"]),
            displayName: z.string().trim().min(1).max(500),
            updatedAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export type IntegrationsAdminOverviewRequest = z.infer<
  typeof integrationsAdminOverviewRequestSchema
>;
export type IntegrationsAdminOverviewResponse = z.infer<
  typeof integrationsAdminOverviewResponseSchema
>;

export class TfIntegrationsAdminOverviewService {
  constructor(private readonly repository: AdminConnectionSummaryRepository) {}

  async load(
    input: IntegrationsAdminOverviewRequest,
  ): Promise<IntegrationsAdminOverviewResponse> {
    const request = integrationsAdminOverviewRequestSchema.parse(input);
    const connections = await this.repository.listAdminConnectionSummaries(
      request.accountIds,
    );
    return integrationsAdminOverviewResponseSchema.parse({
      connections: connections.map((connection) => ({
        accountId: connection.accountId,
        provider: connection.provider,
        displayName: connection.displayName,
        updatedAt: connection.updatedAt.toISOString(),
      })),
    });
  }
}
