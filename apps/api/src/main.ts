import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import pino from "pino";

import { closeDatabase, initDatabase } from "@watchmygate/db";

import { AppModule } from "./app.module.js";
import { loadConfig } from "./common/config.js";
import { AppExceptionFilter } from "./common/exception.filter.js";

const config = loadConfig();

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(config.isProduction
    ? {}
    : { transport: { target: "pino-pretty", options: { colorize: true } } }),
  // Belt and braces: even if a secret reaches a log call, it is redacted on the way out.
  redact: {
    paths: [
      "req.headers.authorization",
      "*.password",
      "*.codeHash",
      "*.refreshToken",
      "*.keySecret",
      "*.credentialsSecretRef",
      "otp",
      "code",
    ],
    censor: "[redacted]",
  },
});

async function bootstrap(): Promise<void> {
  initDatabase(config.DATABASE_URL);

  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new AppExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(config.PORT, "0.0.0.0");

  logger.info(
    {
      environment: config.ENVIRONMENT,
      region: config.GCP_REGION,
      port: config.PORT,
      smsStubbed: config.smsIsStubbed,
      paymentsStubbed: config.paymentsAreStubbed,
      storageStubbed: config.storageIsStubbed,
      tasksStubbed: config.tasksAreStubbed,
    },
    "api started",
  );

  if (config.smsIsStubbed && !config.isProduction) {
    logger.warn("SMS stub mode — OTP codes are written to this log, not sent.");
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void (async () => {
        logger.info("shutting down");
        await app.close();
        await closeDatabase();
        process.exit(0);
      })();
    });
  }
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ error }, "failed to start");
  process.exit(1);
});
