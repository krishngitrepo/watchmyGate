/**
 * End-to-end smoke test against a running API and the real database.
 *
 * Exercises the paths that unit tests cannot: real HTTP, real auth, real RLS, real
 * Postgres constraints. This is what catches the class of bug where every piece is
 * individually correct and the assembly is not — the middleware path bug that made
 * login unreachable passed every unit test in the repo.
 *
 *   node --env-file=.env scripts/e2e-smoke.mjs
 *
 * Expects: migrations applied, seed run, API listening on PORT (default 8080).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";

const API = process.env.E2E_API ?? `http://localhost:${process.env.PORT ?? 8080}`;
const API_LOG = process.env.E2E_API_LOG ?? "/tmp/api4.log";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

/** Read the OTP the SMS stub wrote to the API log. */
function latestOtp(phone) {
  const log = readFileSync(API_LOG, "utf8");
  const lines = log.split("\n").filter((l) => l.includes("sms_stub_otp") && l.includes(phone));
  const last = lines.at(-1);
  if (!last) throw new Error(`No stub OTP found for ${phone} in ${API_LOG}`);
  return JSON.parse(last.slice(last.indexOf("{"))).code;
}

async function login(phone, societyId) {
  const requested = await api("/v1/auth/otp/request", {
    method: "POST",
    body: { phone },
  });
  if (requested.status !== 202) {
    throw new Error(`OTP request failed: ${requested.status} ${JSON.stringify(requested.body)}`);
  }
  await new Promise((r) => setTimeout(r, 400));

  const verified = await api("/v1/auth/otp/verify", {
    method: "POST",
    body: { phone, code: latestOtp(phone), societyId },
  });
  if (!verified.body.accessToken) {
    throw new Error(`Login failed: ${JSON.stringify(verified.body)}`);
  }
  return verified.body.accessToken;
}

async function main() {
  const db = new pg.Client({
    connectionString: process.env.DATABASE_MIGRATION_URL,
    ssl: { rejectUnauthorized: true },
  });
  await db.connect();

  const { rows: societies } = await db.query(
    "SELECT id FROM societies WHERE slug = 'brigade-lakefront'",
  );
  const societyId = societies[0]?.id;
  if (!societyId) throw new Error("Seed has not been run — no brigade-lakefront society.");

  await db.query("SELECT set_config('app.society_id', $1, false)", [societyId]);
  const { rows: units } = await db.query("SELECT id, number FROM units ORDER BY number");
  const unitA101 = units.find((u) => u.number === "A-101").id;

  console.log(`\nsociety ${societyId}\nunit A-101 ${unitA101}\n`);

  // ---------------------------------------------------------------- health
  console.log("health");
  const health = await api("/healthz");
  check("liveness is public and returns 200", health.status === 200, `got ${health.status}`);
  const ready = await api("/readyz");
  check("readiness reaches the database", ready.status === 200, `got ${ready.status}`);

  // ------------------------------------------------------------------ auth
  console.log("\nauth");
  const anon = await api("/v1/gate/inside");
  check("protected route rejects an anonymous caller", anon.status === 401);

  const guardToken = await login("+919900000003", societyId);
  check("guard can log in", Boolean(guardToken));
  const residentToken = await login("+919900000002", societyId);
  check("resident can log in", Boolean(residentToken));

  // ------------------------------------------------------------------ gate
  console.log("\ngate — offline verification keys");
  const keys = await api("/v1/gate/keys", { token: guardToken });
  check("guard receives signing keys", keys.status === 200 && Array.isArray(keys.body.keys),
    JSON.stringify(keys.body).slice(0, 120));

  console.log("\ngate — pass issuance");
  const pass = await api("/v1/gate/passes", {
    method: "POST",
    token: guardToken,
    body: {
      unitId: unitA101,
      visitorName: "Ravi Kumar",
      visitorPhone: "+919900000099",
      category: "guest",
      validFrom: "2026-08-14T00:00:00Z",
      validTo: "2026-08-15T00:00:00Z",
      maxUses: 1,
    },
  });
  check("pass is issued", pass.status === 201 || pass.status === 200,
    JSON.stringify(pass.body).slice(0, 200));
  const qr = pass.body.qrValue ?? "";
  check("QR does not contain the visitor's name",
    !Buffer.from(qr.split(".")[0] ?? "", "base64url").toString("utf8").includes("Ravi"));
  check("QR does not contain the visitor's phone",
    !Buffer.from(qr.split(".")[0] ?? "", "base64url").toString("utf8").includes("9900000099"));

  // -------------------------------------------------------- outbox sync
  console.log("\ngate — offline outbox sync");
  const ev1 = randomUUID();
  const ev2 = randomUUID();
  const batch = {
    events: [
      {
        id: ev1,
        unitId: unitA101,
        passId: pass.body.passId,
        direction: "entry",
        category: "guest",
        visitorName: "Ravi Kumar",
        verifiedOffline: true,
        // Deliberately two hours behind: guard handset clocks are routinely wrong.
        deviceTs: new Date(Date.now() - 2 * 3600_000).toISOString(),
      },
      {
        id: ev2,
        unitId: unitA101,
        direction: "entry",
        category: "delivery",
        visitorName: "Amazon delivery",
        deviceTs: new Date().toISOString(),
      },
    ],
  };

  const sync1 = await api("/v1/gate/sync", { method: "POST", token: guardToken, body: batch });
  check("both events accepted", sync1.body.accepted === 2,
    JSON.stringify(sync1.body).slice(0, 250));
  check("clock drift is detected and reported",
    Math.abs(sync1.body.maxDriftSeconds) > 7000,
    `drift=${sync1.body.maxDriftSeconds}`);

  // The property the whole offline design rests on.
  const sync2 = await api("/v1/gate/sync", { method: "POST", token: guardToken, body: batch });
  check("replaying the same batch inserts nothing new",
    sync2.body.accepted === 0 && sync2.body.duplicates === 2,
    JSON.stringify(sync2.body).slice(0, 250));

  const sync3 = await api("/v1/gate/sync", { method: "POST", token: guardToken, body: batch });
  check("a third replay is still idempotent", sync3.body.duplicates === 2);

  const { rows: eventCount } = await db.query(
    "SELECT count(*)::int n FROM gate_events WHERE id = ANY($1::uuid[])",
    [[ev1, ev2]],
  );
  check("exactly 2 rows exist after 3 identical submissions", eventCount[0].n === 2,
    `found ${eventCount[0].n}`);

  // A single-use pass must not be burnt down by replays.
  const { rows: passRows } = await db.query(
    "SELECT uses, status FROM visitor_passes WHERE id = $1",
    [pass.body.passId],
  );
  check("pass use counted exactly once despite 3 replays", passRows[0].uses === 1,
    `uses=${passRows[0].uses}`);
  check("single-use pass retired after use", passRows[0].status === "used",
    `status=${passRows[0].status}`);

  // One bad event must not wedge the whole outbox.
  const mixed = await api("/v1/gate/sync", {
    method: "POST",
    token: guardToken,
    body: {
      events: [
        {
          id: randomUUID(),
          unitId: unitA101,
          direction: "entry",
          category: "guest",
          deviceTs: "not-a-timestamp",
        },
        {
          id: randomUUID(),
          unitId: unitA101,
          direction: "exit",
          category: "guest",
          deviceTs: new Date().toISOString(),
        },
      ],
    },
  });
  check("a malformed event is rejected individually, not the batch",
    mixed.body.accepted === 1 && mixed.body.rejected === 1,
    JSON.stringify(mixed.body).slice(0, 250));

  // -------------------------------------------------------- approval ladder
  console.log("\ngate — approval ladder");
  const approval = await api("/v1/gate/approvals", {
    method: "POST",
    token: guardToken,
    body: { unitId: unitA101, category: "delivery", visitorName: "Amazon delivery" },
  });
  const approvalId = approval.body.approvalId;
  check("approval request created", Boolean(approvalId),
    JSON.stringify(approval.body).slice(0, 200));

  const history = await api(`/v1/gate/approvals/${approvalId}/history`, { token: guardToken });
  check("push rung fired immediately and is recorded",
    history.body.rungs?.some((r) => r.rung === "push"),
    JSON.stringify(history.body).slice(0, 200));

  const decided = await api(`/v1/gate/approvals/${approvalId}/decision`, {
    method: "POST",
    token: residentToken,
    body: { decision: "approved" },
  });
  check("resident can approve", decided.body.state === "approved",
    JSON.stringify(decided.body).slice(0, 200));

  const second = await api(`/v1/gate/approvals/${approvalId}/decision`, {
    method: "POST",
    token: residentToken,
    body: { decision: "denied" },
  });
  check("a second decision is refused — first response wins", second.status === 422,
    `status=${second.status} ${JSON.stringify(second.body).slice(0, 150)}`);

  // ------------------------------------------------------------- helpdesk
  console.log("\nhelpdesk — the lift complaint");
  const categories = await api("/v1/tickets/categories", { token: residentToken });
  const lighting = Array.isArray(categories.body)
    ? categories.body.find((c) => c.name === "Lighting")
    : null;
  check("seeded category tree is readable", Boolean(lighting),
    JSON.stringify(categories.body).slice(0, 150));

  const ticket = await api("/v1/tickets", {
    method: "POST",
    token: residentToken,
    body: {
      categoryId: lighting.id,
      title: "Light is not working in the lift",
      description: "Tower A lift, ground floor. Dark since Tuesday.",
      locationType: "common",
    },
  });
  check("complaint is raised and gets a ticket number",
    Boolean(ticket.body.ticketNumber),
    JSON.stringify(ticket.body).slice(0, 250));

  // The create response returns only { id, ticketNumber, merged }, so the SLA is read
  // back rather than assumed. Worth checking the actual duration, not just presence:
  // the "Lighting" category is seeded at 8 hours, and a timer that starts but uses the
  // wrong deadline is the kind of thing nobody notices until an escalation never fires.
  const raised = await api(`/v1/tickets/${ticket.body.id}`, { token: residentToken });
  const slaHours =
    (new Date(raised.body.slaDueAt) - new Date(raised.body.createdAt)) / 3_600_000;
  check("SLA timer starts on creation", Boolean(raised.body.slaDueAt));
  check("SLA deadline matches the category's 8-hour target",
    Math.abs(slaHours - 8) < 0.1, `got ${slaHours.toFixed(2)}h`);
  const escalationHours =
    (new Date(raised.body.escalationDueAt) - new Date(raised.body.createdAt)) / 3_600_000;
  check("escalation is scheduled after the SLA, at 16 hours",
    Math.abs(escalationHours - 16) < 0.1, `got ${escalationHours.toFixed(2)}h`);

  const presign = await api(`/v1/tickets/${ticket.body.id}/attachments/presign`, {
    method: "POST",
    token: residentToken,
    body: { contentType: "image/jpeg", contentLength: 220_000 },
  });
  check("photo upload can be presigned (2 lift photos)",
    presign.status === 200 || presign.status === 201,
    JSON.stringify(presign.body).slice(0, 200));

  const resolveTooEarly = await api(`/v1/tickets/${ticket.body.id}/status`, {
    method: "POST",
    token: residentToken,
    body: { status: "resolved" },
  });
  check("cannot resolve without a proof-of-fix photo", resolveTooEarly.status === 422,
    `status=${resolveTooEarly.status}`);

  // ------------------------------------------------------ tenant isolation
  console.log("\ntenant isolation over HTTP");
  const otherSociety = await db.query(
    `INSERT INTO societies (name, slug, state_code, status)
     VALUES ('E2E Other Society', $1, 'KA', 'active') RETURNING id`,
    [`e2e-other-${randomUUID().slice(0, 8)}`],
  );
  const otherId = otherSociety.rows[0].id;
  const crossToken = await login("+919900000003", societyId);
  const crossRead = await api(`/v1/gate/approvals/${approvalId}`, { token: crossToken });
  check("own society's approval is readable", crossRead.status === 200);

  /**
   * The authorization hole this run found.
   *
   * Login accepted any societyId and issued a session scoped to it with an empty roles
   * array. Role-gated endpoints refused that token, but every endpoint relying on tenant
   * scoping alone — listing complaints, for one — would have served another society's
   * data quite happily. An empty roles array reads as "no permissions" but actually
   * meant "not a member", and those are not the same thing.
   */
  await api("/v1/auth/otp/request", { method: "POST", body: { phone: "+919900000003" } });
  await new Promise((r) => setTimeout(r, 400));
  const stolen = await api("/v1/auth/otp/verify", {
    method: "POST",
    body: {
      phone: "+919900000003",
      code: latestOtp("+919900000003"),
      societyId: otherId, // a real society the guard has no role in
    },
  });
  check("cannot obtain a token for a society you are not a member of",
    stolen.status === 403 && !stolen.body.accessToken,
    `status=${stolen.status} ${JSON.stringify(stolen.body).slice(0, 150)}`);

  await db.query("DELETE FROM societies WHERE id = $1", [otherId]);

  await db.end();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nE2E ABORTED:", error.message);
  process.exit(1);
});
