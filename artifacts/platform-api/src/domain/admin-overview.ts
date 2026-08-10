import type { Pool } from "pg";
import { z } from "zod";

import type {
  AdminAccountOverviewRepository,
} from "./repository.js";

const ACCOUNT_LIMIT = 100;

const accountSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email().max(320),
    displayName: z.string().trim().min(1).max(256),
    status: z.enum(["pending", "active", "suspended", "deleted"]),
    latestActivityAt: z.string().datetime({ offset: true }).optional(),
    activeSessionCount: z.number().int().nonnegative().max(1_000_000),
    moduleKeys: z.array(z.string().trim().min(1).max(128)).max(64),
  })
  .strict();

export const platformAdminOverviewSchema = z
  .object({
    total: z.number().int().nonnegative().max(1_000_000_000),
    activeNow: z.number().int().nonnegative().max(1_000_000_000),
    pending: z.number().int().nonnegative().max(1_000_000_000),
    suspended: z.number().int().nonnegative().max(1_000_000_000),
    accounts: z.array(accountSchema).max(ACCOUNT_LIMIT),
  })
  .strict();

export type PlatformAdminOverview = z.infer<typeof platformAdminOverviewSchema>;

export class PlatformAdminOverviewService {
  constructor(
    private readonly pool: Pool,
    private readonly repository: AdminAccountOverviewRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<PlatformAdminOverview> {
    const now = this.now();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error("admin overview clock unavailable");
    }
    const client = await this.pool.connect();
    try {
      const overview = await this.repository.getAdminAccountOverview(
        client,
        now,
        ACCOUNT_LIMIT,
      );
      return platformAdminOverviewSchema.parse({
        total: overview.total,
        activeNow: overview.activeNow,
        pending: overview.pending,
        suspended: overview.suspended,
        accounts: overview.accounts.map((account) => ({
          id: account.id,
          email: account.email,
          displayName: account.displayName,
          status: account.status,
          ...(account.latestActivityAt === null
            ? {}
            : { latestActivityAt: account.latestActivityAt.toISOString() }),
          activeSessionCount: account.activeSessionCount,
          moduleKeys: account.moduleKeys,
        })),
      });
    } finally {
      client.release();
    }
  }
}
