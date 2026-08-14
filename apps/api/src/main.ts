import "reflect-metadata";

import { createRequire } from "node:module";

import { NestFactory } from "@nestjs/core";
import pino from "pino";

import { closeDatabase, initDatabase } from "@watchmygate/db";

import { AppModule } from "./app.module.js";
import { loadConfig } from "./common/config.js";
import { AppExceptionFilter } from "./common/exception.filter.js";

const config = loadConfig();

/**
 * Human-readable logs in development, JSON in production.
 *
 * `pino-pretty` is a dev convenience and an optional dependency, so its absence must
 * never stop the service booting — pino throws at construction if the transport target
 * cannot be resolved, which would turn a missing log formatter into an outage.
 */
function prettyTransport(): pino.LoggerOptions {
  if (config.isProduction) return {};
  try {
    // This module is ESM, so `require` is not in scope — createRequire gives us the
    // resolver without pulling in a CommonJS loader for anything else.
    createRequire(import.meta.url).resolve("pino-pretty");
    return { transport: { target: "pino-pretty", options: { colorize: true } } };
  } catch {
    return {};
  }
}

export const logger = pino({
  level: config.LOG_LEVEL,
  ...prettyTransport(),
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
