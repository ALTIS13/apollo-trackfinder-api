import Redis from "ioredis";

interface RedisHealthProbeOptions {
  timeoutMs?: number;
}

export async function probeRedisHealth(
  url: string,
  options: RedisHealthProbeOptions = {},
): Promise<boolean> {
  const timeoutMs = Math.min(10_000, Math.max(100, options.timeoutMs ?? 1_200));
  const client = new Redis(url, {
    autoResendUnfulfilledCommands: false,
    commandTimeout: timeoutMs,
    connectTimeout: timeoutMs,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on("error", () => undefined);

  let timeout: NodeJS.Timeout | undefined;
  try {
    const lifecycle = (async () => {
      await client.connect();
      return (await client.ping()) === "PONG";
    })();
    const deadline = new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([lifecycle, deadline]);
  } catch {
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    client.disconnect(false);
  }
}
