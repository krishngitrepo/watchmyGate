/**
 * Phase 2 smoke test — exercises the new modules against the running API.
 *
 * Not a substitute for the unit tests; this is the check that the routes are actually
 * reachable and the invariants hold end to end. The earlier login bug in this project
 * typechecked, unit-tested and still made the whole API unusable — only calling it
 * found that.
 */

import { readFileSync } from "node:fs";

const BASE = "http://localhost:8080";
const ADMIN = "+919900000001";
let token = "";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function login() {
  await call("POST", "/v1/auth/otp/request", { phone: ADMIN });
  await new Promise((r) => setTimeout(r, 400));
  const { code } = JSON.parse(readFileSync(".otp-stub.json", "utf8"));
  const verify = await call("POST", "/v1/auth/otp/verify", { phone: ADMIN, code });
  token = verify.body.accessToken;
  const mine = await call("GET", "/v1/auth/me/memberships");
  const societyId = mine.body[0].societyId;
  const scoped = await call("POST", "/v1/auth/refresh", {
    refreshToken: verify.body.refreshToken,
    societyId,
  });
  token = scoped.body.accessToken;
  return societyId;
}

const stamp = Date.now().toString().slice(-6);

async function main() {
  await login();
  console.log("\n--- staff & attendance ---");

  const created = await call("POST", "/v1/staff", {
    fullName: `E2E Lakshmi ${stamp}`,
    phone: `+9199${stamp}01`,
    kind: "maid",
  });
  check("staff created", created.status === 200 || created.status === 201, JSON.stringify(created.body).slice(0, 120));
  const staffId = created.body?.id;

  check("PIN hash never returned by create", created.body?.gatePinHash === undefined);

  await call("POST", `/v1/staff/${staffId}/status`, { status: "active" });
  await call("POST", `/v1/staff/${staffId}/pin`, { pin: "4821" });

  const list = await call("GET", "/v1/staff");
  check(
    "PIN hash never in the staff list",
    !JSON.stringify(list.body).includes("gatePinHash"),
  );

  const wrongPin = await call("POST", "/v1/staff/attendance/check-in", {
    staffId,
    method: "pin",
    pin: "0000",
  });
  check("wrong PIN rejected", wrongPin.status === 422, `got ${wrongPin.status}`);

  const rightPin = await call("POST", "/v1/staff/attendance/check-in", {
    staffId,
    method: "pin",
    pin: "4821",
  });
  check("right PIN checks in", rightPin.body?.status === "checked_in", JSON.stringify(rightPin.body).slice(0, 120));

  const twice = await call("POST", "/v1/staff/attendance/check-in", {
    staffId,
    method: "gate_scan",
  });
  check("second scan does not open a second shift", twice.body?.status === "already_in");

  const present = await call("GET", "/v1/staff/attendance/present");
  check("appears in present list", JSON.stringify(present.body).includes(staffId));

  const out = await call("POST", "/v1/staff/attendance/check-out", { staffId });
  check("checks out", out.body?.status === "checked_out");

  const month = new Date().toISOString().slice(0, 7);
  const sheet = await call("GET", `/v1/staff/timesheet?month=${month}`);
  check("timesheet returns rows", Array.isArray(sheet.body) && sheet.body.length > 0);
  const mine = (sheet.body ?? []).find((r) => r.staffId === staffId);
  check("timesheet counts the day", mine?.daysPresent === 1, JSON.stringify(mine));

  // Aadhaar must be impossible to store, not merely discouraged.
  const badId = await call("POST", `/v1/staff/${staffId}/verification`, {
    status: "verified",
    idLast4: "123456789012",
  });
  check("full Aadhaar-length id rejected", badId.status === 422, `got ${badId.status}`);

  const goodId = await call("POST", `/v1/staff/${staffId}/verification`, {
    status: "verified",
    idLast4: "9012",
  });
  check("masked last-4 accepted", goodId.status === 200 || goodId.status === 201);

  console.log("\n--- deliveries ---");
  const parcel = await call("POST", "/v1/deliveries", {
    courier: "Blue Dart",
    parcelCount: 1,
  });
  check("delivery logged", Boolean(parcel.body?.id), JSON.stringify(parcel.body).slice(0, 120));
  const did = parcel.body?.id;

  const illegal = await call("POST", "/v1/deliveries/advance", {
    id: did,
    status: "delivered",
    handoverTo: "someone",
  });
  check("cannot jump straight to delivered", illegal.status === 422, `got ${illegal.status}`);

  await call("POST", "/v1/deliveries/advance", { id: did, status: "out_for_doorstep" });
  const noProof = await call("POST", "/v1/deliveries/advance", { id: did, status: "delivered" });
  check("delivered without a recipient is refused", noProof.status === 422, `got ${noProof.status}`);

  const done = await call("POST", "/v1/deliveries/advance", {
    id: did,
    status: "delivered",
    handoverTo: "Priya Menon",
  });
  check("delivered with a recipient succeeds", done.body?.status === "delivered");
  check("handover time recorded", Boolean(done.body?.handoverAt));

  const afterTerminal = await call("POST", "/v1/deliveries/advance", {
    id: did,
    status: "at_gate",
  });
  check("terminal state cannot be reopened", afterTerminal.status === 422, `got ${afterTerminal.status}`);

  console.log("\n--- notices & polls ---");
  const poll = await call("POST", "/v1/notices", {
    kind: "poll",
    title: `E2E gym hours ${stamp}`,
    body: "Which hours suit you?",
    audience: "society",
    options: ["6-9am", "6-9pm"],
  });
  check("poll created", Boolean(poll.body?.id), JSON.stringify(poll.body).slice(0, 120));

  // The DLT rule: a poll is service_implicit and may use SMS; an event is promotional.
  check("poll may use SMS", (poll.body?.channels ?? []).includes("sms"));

  const event = await call("POST", "/v1/notices", {
    kind: "event",
    title: `E2E diwali ${stamp}`,
    body: "Party",
    audience: "society",
  });
  check("event is promotional", event.body?.dltCategory === "promotional");
  check(
    "promotional notice is refused SMS and WhatsApp",
    !(event.body?.channels ?? []).includes("sms") &&
      !(event.body?.channels ?? []).includes("whatsapp"),
    JSON.stringify(event.body?.channels),
  );

  const emergency = await call("POST", "/v1/notices", {
    kind: "emergency",
    title: `E2E water ${stamp}`,
    body: "No water tomorrow",
    audience: "society",
  });
  check("emergency is transactional", emergency.body?.dltCategory === "transactional");

  const opts = await call("GET", `/v1/notices/${poll.body.id}/results`);
  check("poll has two options", (opts.body ?? []).length === 2);

  await call("POST", `/v1/notices/${poll.body.id}/vote`, { optionId: opts.body[0].optionId });
  const after1 = await call("POST", `/v1/notices/${poll.body.id}/vote`, {
    optionId: opts.body[1].optionId,
  });
  const total = (after1.body ?? []).reduce((n, o) => n + o.votes, 0);
  check("changing a vote does not add a second", total === 1, `total=${total}`);

  await call("POST", `/v1/notices/${poll.body.id}/read`);
  await call("POST", `/v1/notices/${poll.body.id}/read`);
  const reads = await call("GET", `/v1/notices/${poll.body.id}/reads`);
  check("read receipt is idempotent", reads.body?.readers === 1, JSON.stringify(reads.body));

  console.log("\n--- vehicles & parking ---");
  const veh = await call("POST", "/v1/parking/vehicles", {
    plate: `ka ${stamp} mj 9876`,
    staffId,
    kind: "two_wheeler",
  });
  check("vehicle registered", Boolean(veh.body?.id), JSON.stringify(veh.body).slice(0, 140));
  check("plate normalised on store", veh.body?.plate === `KA${stamp}MJ9876`, veh.body?.plate);

  const dup = await call("POST", "/v1/parking/vehicles", {
    plate: `KA-${stamp}-MJ-9876`,
    staffId,
  });
  check("same plate written differently is a duplicate", dup.status === 409, `got ${dup.status}`);

  const found = await call("GET", `/v1/parking/lookup?plate=KA.${stamp}.MJ.9876`);
  check("gate lookup finds it despite punctuation", found.body?.known === true);

  const unknown = await call("GET", "/v1/parking/lookup?plate=ZZ00ZZ0000");
  check("unknown plate is an answer, not an error", unknown.status === 200 && unknown.body?.known === false);

  const slot = await call("POST", "/v1/parking/slots", { code: `E2E-${stamp}`, kind: "covered" });
  check("slot created", Boolean(slot.body?.id));

  const allot = await call("POST", "/v1/parking/slots/allot", {
    slotId: slot.body.id,
    vehicleId: veh.body.id,
  });
  check("slot allotted", Boolean(allot.body?.vehicleId));

  const slot2 = await call("POST", "/v1/parking/slots", { code: `E2E-${stamp}-B` });
  const double = await call("POST", "/v1/parking/slots/allot", {
    slotId: slot2.body.id,
    vehicleId: veh.body.id,
  });
  check("one vehicle cannot hold two slots", double.status === 409, `got ${double.status}`);

  const viol = await call("POST", "/v1/parking/violations", {
    plate: "ZZ00ZZ0000",
    reason: "Blocking the ramp",
  });
  check("violation on an unregistered plate is recorded", viol.body?.registeredVehicle === false);

  console.log("\n--- cleanup ---");
  await call("POST", `/v1/parking/slots/${slot.body.id}/release`);
  await call("POST", `/v1/parking/slots/${slot2.body.id}/release`);
  await call("DELETE", `/v1/parking/vehicles/${veh.body.id}`);
  if (viol.body?.id) await call("POST", `/v1/parking/violations/${viol.body.id}/resolve`);
  console.log("  cleaned");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
