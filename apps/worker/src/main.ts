/**
 * WatchMyGate worker — scheduled and deferred work.
 *
 * ## Why this service exists at all
 *
 * Cloud Run terminates a container once it returns a response. There is therefore
 * nowhere in the API for "call this resident again in 20 seconds" to live: the process
 * handling the request is gone before the timer fires. The API's local fallback uses
 * in-process timers, which is fine for a demo and useless in production — a deploy
 * drops every pending rung silently.
 *
 * So the work that must outlive a request lives here, triggered from outside:
 *
 *   Cloud Tasks      → POST /tasks/approval-rung   (per approval, scheduled)
 *   Cloud Scheduler  → POST /jobs/<name>           (on a clock)
 *
 * ## Deliberately a plain HTTP server
 *
 * No Nest, no DI container. This service has six routes and no domain model; a
 * framework would be more code than the thing it frames.
 *
 * ## Every handler is idempotent
 *
 * Cloud Tasks and Cloud Scheduler both guarantee at-least-once delivery, never
 * exactly-once. Duplicate delivery is normal operation, not an error case — a billing
 * run that issued a second invoice on a retry would be a financial incident.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { loadConfig } from "./config.js";
import {
  advanceApproval,
  auditPartitions,
  billingRun,
  ledgerInvariants,
  overstaySweep,
  slaSweep,
} from "./jobs.js";

const config = loadConfig();

function log(level: "info" | "warn" | "error", event: string, data: object = {}): void {
  // Structured JSON so Cloud Logging indexes the fields rather than storing a blob.
  // eslint-disable-next-line no-console
  console[level](JSON.stringify({ severity: level.toUpperCase(), event, ...data }));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // A job payload is a handful of fields. Anything larger is a mistake or an attack.
    if (size > 1_000_000) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Verify the caller is our own scheduler.
 *
 * These endpoints trigger billing runs across every society, so an unauthenticated
 * caller could bill a whole portfolio repeatedly. In production Cloud Tasks and
 * Scheduler present an OIDC token; locally the shared service token stands in.
 *
 * Constant-time comparison — a plain `===` leaks the token's prefix through timing.
 */
function authorised(req: IncomingMessage): boolean {
  const presented = req.headers["x-service-token"];
  if (typeof presented === "string") {
    const a = Buffer.from(presented);
    const b = Buffer.from(config.SERVICE_TOKEN);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }

  // Cloud Run verifies the OIDC signature before the request reaches us, so the
  // presence of the header here means Google already vouched for the caller.
  const authHeader = req.headers.authorization;
  if (config.WORKER_AUDIENCE && authHeader?.startsWith("Bearer ")) return true;

  return false;
}

type Handler = (body: Record<string, unknown>) => Promise<unknown>;

const routes: Record<string, Handler> = {
  // Cloud Tasks — one scheduled delivery per approval per rung.
  "/tasks/approval-rung": async (body) =>
    advanceApproval({
      societyId: String(body.societyId),
      approvalId: String(body.approvalId),
    }),

  // Cloud Scheduler.
  "/jobs/sla-sweep": () => slaSweep(),
  "/jobs/overstay-sweep": () => overstaySweep(),
  "/jobs/ledger-invariants": () => ledgerInvariants(),
  "/jobs/billing-run": (body) =>
    billingRun({
      ...(body.dryRun === true ? { dryRun: true } : {}),
      ...(typeof body.month === "string" ? { month: body.month } : {}),
    }),
  "/jobs/audit-partitions": () => auditPartitions(),
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  const send = (status: number, payload: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };

  // Liveness deliberately touches nothing. Restarting the worker will not fix an API
  // outage; it would just cycle instances during an incident.
  if (path === "/healthz") {
    send(200, { status: "ok" });
    return;
  }

  const handler = routes[path];
  if (!handler) {
    send(404, { error: "No such job." });
    return;
  }

  if (req.method !== "POST") {
    send(405, { error: "Jobs are triggered with POST." });
    return;
  }

  if (!authorised(req)) {
    log("warn", "worker_unauthorised", { path });
    send(401, { error: "Unauthorised." });
    return;
  }

  const started = Date.now();
  try {
    const result = await handler(await readBody(req));
    log("info", "job_complete", { path, durationMs: Date.now() - started });
    send(200, result);
  } catch (error) {
    const message = (error as Error).message;
    log("error", "job_failed", { path, error: message, durationMs: Date.now() - started });

    // 500 tells Cloud Tasks and Scheduler to retry with their own backoff. That is the
    // behaviour we want: their retry policy is more durable than anything in-process.
    send(500, { error: message });
  }
}

server.listen(config.PORT, "0.0.0.0", () => {
  log("info", "worker_started", {
    port: config.PORT,
    environment: config.ENVIRONMENT,
    coreApi: config.CORE_API_URL,
    oidcEnforced: Boolean(config.WORKER_AUDIENCE),
    jobs: Object.keys(routes),
  });
});

// Cloud Run sends SIGTERM and then waits. Finishing in-flight work rather than dropping
// it is the difference between a clean deploy and a half-written billing run.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log("info", "worker_stopping", { signal });
    server.close(() => process.exit(0));
  });
}
