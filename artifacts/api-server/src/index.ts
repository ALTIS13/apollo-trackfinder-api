import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "./lib/migrate";
import { getRedis } from "./lib/redis";
import { attachWebSocketServer } from "./ws";

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
  .then(() => {
    const server = app.listen(port, (err: unknown) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
    attachWebSocketServer(server);
  })
  .catch((err) => {
    logger.error({ err }, "Migration failed — server will not start");
    process.exit(1);
  });
