import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { getRedis } from "./lib/redis";
import { attachWebSocketServer } from "./ws";
import { initBackgroundQueues, shutdownBackgroundQueues } from "./lib/background-queue";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

getRedis();

runMigrations()
  .then(async () => {
    const server = app.listen(port, (err: unknown) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
    attachWebSocketServer(server);

    await initBackgroundQueues();

    const shutdown = async () => {
      logger.info("Shutting down background queues...");
      await shutdownBackgroundQueues();
      process.exit(0);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  })
  .catch((err) => {
    logger.error({ err }, "Migration failed — server will not start");
    process.exit(1);
  });
