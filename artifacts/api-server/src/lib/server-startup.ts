import type { Server } from "node:http";

interface ApiListenerOptions {
  readonly listen: () => Server;
  readonly initialize: (server: Server) => Promise<void>;
  readonly closeQueues: () => Promise<void>;
  readonly closeRedis: () => Promise<void>;
}

async function waitForListening(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    const onError = (): void => {
      server.off("listening", onListening);
      reject(new Error("listener unavailable"));
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export async function startApiListener(
  options: ApiListenerOptions,
): Promise<Server> {
  const server = options.listen();
  try {
    await waitForListening(server);
    await options.initialize(server);
    return server;
  } catch {
    await Promise.allSettled([
      closeServer(server),
      options.closeQueues(),
      options.closeRedis(),
    ]);
    throw new Error("TF API startup failed");
  }
}
