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

/**
 * Where the SMS stub records the last OTP it "sent".
 *
 * This used to scrape the API's stdout log, which coupled the whole suite to whichever
 * file the API process happened to be started with — start it elsewhere and every login
 * failed with an unhelpful ENOENT. A known file written by the stub is deterministic.
 */
const OTP_FILE = process.env.OTP_STUB_FILE ?? ".otp-stub.json";

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

/** Read the OTP the SMS stub just recorded. */
function latestOtp(phone) {
  let record;
  try {
    record = JSON.parse(readFileSync(OTP_FILE, "utf8"));
  } catch {
    throw new Error(
      `No stubbed OTP at ${OTP_FILE}. Is the API running with MSG91 credentials blank?`,
    );
  }

  // Assert the code belongs to the number we just requested for, so a stale file from
  // an earlier run cannot make a failing login look like it passed.
  if (record.phone !== phone) {
    throw new Error(`Stubbed OTP is for ${record.phone}, expected ${phone}.`);
  }
  return record.code;
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

  // ------------------------------------------------------ society admin
  console.log("\nsociety administration");
  const adminToken = await login("+919900000001", societyId);

  const summary = await api("/v1/society/summary", { token: adminToken });
  check("committee dashboard summary loads", summary.status === 200 && summary.body.units > 0,
    JSON.stringify(summary.body).slice(0, 200));
  check("outstanding dues are strings, never floats",
    typeof summary.body.outstanding === "string",
    `got ${typeof summary.body.outstanding}`);

  const towers = await api("/v1/society/towers", { token: adminToken });
  check("towers list", Array.isArray(towers.body) && towers.body.length >= 2);

  // A resident must not be able to reshape the society.
  const residentTower = await api("/v1/society/towers", {
    method: "POST",
    token: residentToken,
    body: { name: `Sneaky ${randomUUID().slice(0, 6)}` },
  });
  check("a resident cannot create a tower", residentTower.status === 403,
    `status=${residentTower.status}`);

  // Nor grant themselves a role — the classic privilege-escalation path.
  const residentGrant = await api("/v1/society/roles", {
    method: "POST",
    token: residentToken,
    body: { phone: "+919900000002", roleCode: "society_admin" },
  });
  check("a resident cannot grant themselves admin", residentGrant.status === 403,
    `status=${residentGrant.status}`);

  const newTower = await api("/v1/society/towers", {
    method: "POST",
    token: adminToken,
    body: { name: `Tower E2E ${randomUUID().slice(0, 6)}`, floors: 8 },
  });
  check("admin can create a tower", Boolean(newTower.body.id),
    JSON.stringify(newTower.body).slice(0, 200));

  const bulk = await api("/v1/society/units/bulk", {
    method: "POST",
    token: adminToken,
    body: {
      units: [
        { towerId: newTower.body.id, number: "E-101", floor: 1, carpetAreaSqft: "1000.00", bhk: 2 },
        { towerId: newTower.body.id, number: "E-102", floor: 1, carpetAreaSqft: "1400.00", bhk: 3 },
        { towerId: newTower.body.id, number: "E-101", floor: 1 }, // deliberate duplicate
      ],
    },
  });
  check("bulk import creates the good rows and reports the bad one",
    bulk.body.created === 2 && bulk.body.skipped?.length === 1,
    JSON.stringify(bulk.body).slice(0, 250));

  // Occupancy: the owner votes, the tenant pays.
  const e2eUnits = await api(`/v1/society/units?towerId=${newTower.body.id}`, { token: adminToken });
  const e101 = e2eUnits.body.find((u) => u.number === "E-101");

  await api("/v1/society/occupancies", {
    method: "POST",
    token: adminToken,
    body: {
      unitId: e101.id, phone: "+919900000077", name: "Owner Abroad",
      relationship: "owner", isBillingLiable: false, hasVotingRight: true,
      hasAppAccess: true, validFrom: "2026-01-01",
    },
  });
  await api("/v1/society/occupancies", {
    method: "POST",
    token: adminToken,
    body: {
      unitId: e101.id, phone: "+919900000078", name: "Tenant Paying",
      relationship: "tenant", isBillingLiable: true, hasVotingRight: false,
      hasAppAccess: true, validFrom: "2026-03-01",
    },
  });

  const occupants = await api(`/v1/society/units/${e101.id}/occupants`, { token: adminToken });
  const owner = occupants.body.find((o) => o.relationship === "owner");
  const tenant = occupants.body.find((o) => o.relationship === "tenant");
  check("owner votes but does not pay", owner?.hasVotingRight === true && owner?.isBillingLiable === false);
  check("tenant pays but does not vote", tenant?.isBillingLiable === true && tenant?.hasVotingRight === false);

  /**
   * The reason occupancy is bitemporal. Asked as of February — before the tenant moved
   * in — the tenant must not appear. This is the question a disputed invoice raises.
   */
  const inFebruary = await api(
    `/v1/society/units/${e101.id}/occupants?on=2026-02-15`,
    { token: adminToken },
  );
  check("asking 'who lived here in February' excludes the March tenant",
    inFebruary.body.length === 1 && inFebruary.body[0].relationship === "owner",
    JSON.stringify(inFebruary.body.map((o) => o.relationship)));

  // ------------------------------------------------------------- payments
  console.log("\npayments");
  const unsignedHook = await api("/v1/payments/webhook/razorpay", {
    method: "POST",
    body: { event: "payment.captured" },
  });
  check("webhook rejects an unsigned payload", unsignedHook.status === 401,
    `status=${unsignedHook.status}`);

  const destinations = await api("/v1/payments/destinations", { token: adminToken });
  check("payment destinations list", destinations.status === 200);

  const leakyDestination = await api("/v1/payments/destinations", {
    method: "POST",
    token: adminToken,
    body: {
      payeeType: "society", payeeId: societyId, mode: "route_linked",
      merchantId: "acc_TEST123",
      credentialsSecretRef: "rzp_live_actualsecretkey", // a credential, not a reference
    },
  });
  check("refuses a raw credential where a Secret Manager reference belongs",
    leakyDestination.status === 422,
    `status=${leakyDestination.status}`);

  const residentDestination = await api("/v1/payments/destinations", {
    method: "POST",
    token: residentToken,
    body: { payeeType: "society", payeeId: societyId, mode: "route_linked" },
  });
  check("a resident cannot add a payout destination", residentDestination.status === 403,
    `status=${residentDestination.status}`);

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

  // ------------------------------------------------------------- teardown
  //
  // Sweeps EVERY "Tower E2E%" and both test residents, not just the ones this run made.
  // Runs before the cleanup existed left rows behind, and those older occupancies still
  // referenced the test persons — so a delete scoped to this run's tower hit a foreign
  // key from a previous one. Cleanup that only knows about its own run is cleanup that
  // eventually stops working.
  await db.query("SELECT set_config('app.society_id', $1, false)", [societyId]);

  const testPhones = ["+919900000077", "+919900000078"];

  await db.query(
    `DELETE FROM unit_occupancies
      WHERE unit_id IN (SELECT id FROM units WHERE tower_id IN (
              SELECT id FROM towers WHERE name LIKE 'Tower E2E%'))
         OR person_id IN (SELECT id FROM persons WHERE phone = ANY($1::text[]))`,
    [testPhones],
  );
  await db.query(
    `DELETE FROM units WHERE tower_id IN (
       SELECT id FROM towers WHERE name LIKE 'Tower E2E%')`,
  );
  await db.query("DELETE FROM towers WHERE name LIKE 'Tower E2E%'");
  await db.query("DELETE FROM persons WHERE phone = ANY($1::text[])", [testPhones]);

  const { rows: leftover } = await db.query(
    "SELECT count(*)::int n FROM towers WHERE name LIKE 'Tower E2E%'",
  );
  check("suite cleans up after itself", leftover[0].n === 0, `${leftover[0].n} left behind`);

  await db.end();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nE2E ABORTED:", error.message);
  process.exit(1);
});
