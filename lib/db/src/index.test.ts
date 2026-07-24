import { beforeEach, describe, expect, it, vi } from "vitest";

const pgHarness = vi.hoisted(() => {
  type Connect = () => Promise<void>;
  const clients: Array<{
    readonly config: unknown;
    readonly connect: ReturnType<typeof vi.fn>;
    readonly query: ReturnType<typeof vi.fn>;
    readonly end: ReturnType<typeof vi.fn>;
  }> = [];
  let connect: Connect = async () => undefined;

  class Client {
    readonly connect = vi.fn(() => connect());
    readonly query = vi.fn(async () => ({ rows: [{ "?column?": 1 }] }));
    readonly end = vi.fn(async () => undefined);

    constructor(readonly config: unknown) {
      clients.push(this);
    }
  }

  class Pool {
    constructor(_config: unknown) {}
  }

  return {
    Client,
    Pool,
    clients,
    reset(nextConnect: Connect = async () => undefined) {
      clients.splice(0);
      connect = nextConnect;
    },
  };
});

vi.mock("pg", () => ({
  default: {
    Client: pgHarness.Client,
    Pool: pgHarness.Pool,
  },
}));

vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));

process.env.DATABASE_URL = "postgres://health-test";

const { probeDatabaseHealth } = await import("./index.js");

beforeEach(() => {
  pgHarness.reset();
});

describe("probeDatabaseHealth", () => {
  it("closes a client after a bounded connection failure", async () => {
    pgHarness.reset(async () => {
      throw new Error("dependency unavailable");
    });

    await expect(probeDatabaseHealth({ timeoutMs: 50 })).resolves.toBe(false);

    const [client] = pgHarness.clients;
    expect(client.config).toMatchObject({
      connectionTimeoutMillis: 100,
      query_timeout: 100,
      statement_timeout: 100,
    });
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
