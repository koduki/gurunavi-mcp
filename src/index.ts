import { loadConfig } from "./config.js";
import { createApplication } from "./http/app.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config);
const application = createApplication(config, logger);

application.server.listen(config.port, "0.0.0.0", () => {
  logger.info(
    {
      port: config.port,
      publicBaseUrl: config.publicBaseUrl.toString(),
      serviceMode: config.serviceMode,
      reservationSubmitEnabled: config.reservationSubmitEnabled,
    },
    "Gurunavi MCP is listening",
  );
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "Shutting down");
  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await application.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Shutdown failed");
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
