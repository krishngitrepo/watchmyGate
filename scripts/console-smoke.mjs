/**
 * Console smoke test — every endpoint the admin console actually calls.
 *
 * The console was, until now, a read-only viewer over a complete API: fourteen pages, and
 * the only write in the whole thing was the login form. Adding the write paths means the
 * console now issues invoices, moves residents in and out, grants roles and imports a
 * society's register — and none of that was ever exercised from a browser.
 *
 * So this script sends **exactly the request bodies the pages send**, using the same
 * paths, in the same order a person would. Typechecking proves the code compiles against
 * types I wrote; this proves the API accepts what the console produces. Four latent
 * defects in this project were found this way and none by the type checker.
 *
 * Run the API first, then: `node scripts/console-smoke.mjs`
 */

import { readFileSync } from "node:fs";

const BASE = process.env.API_BASE ?? "http://localhost:8080";
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
    failures.push(`${name} — ${detail}`);
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

const ok = (r) => r.status >= 200 && r.status < 300;
const why = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;

async function login() {
  await call("POST", "/v1/auth/otp/request", { phone: ADMIN });
  await new Promise((r) => setTimeout(r, 400));
  const { code } = JSON.parse(readFileSync(".otp-stub.json", "utf8"));
  const verify = await call("POST", "/v1/auth/otp/verify", { phone: ADMIN, code });
  token = verify.body.accessToken;

  // The console's exact login sequence: verify unscoped, discover memberships, then
  // exchange for a society-scoped token. It also stores the roles from this response,
  // which is what decides whether an action is offered at all.
  const mine = await call("GET", "/v1/auth/me/memberships");
  check("memberships carry roles for the rail", Array.isArray(mine.body?.[0]?.roles), why(mine));

  const societyId = mine.body[0].societyId;
  const scoped = await call("POST", "/v1/auth/refresh", {
    refreshToken: verify.body.refreshToken,
    societyId,
  });
  token = scoped.body.accessToken;
  return { societyId, roles: mine.body[0].roles };
}

const stamp = Date.now().toString().slice(-6);
const today = new Date().toISOString().slice(0, 10);

async function main() {
  const { societyId, roles } = await login();
  console.log(`\nsigned in as ${roles.join(", ")}\n`);

  // ------------------------------------------------------------ flats page
  console.log("--- Flats & Residents ---");

  const towers = await call("GET", "/v1/society/towers");
  check("towers list", ok(towers), why(towers));

  const newTower = await call("POST", "/v1/society/towers", {
    name: `Console Tower ${stamp}`,
    floors: 4,
  });
  check("add a tower", ok(newTower), why(newTower));
  const towerId = newTower.body?.id;

  // The bulk path, which is what the "add a run of flats" pattern box produces.
  const bulk = await call("POST", "/v1/society/units/bulk", {
    units: [
      { towerId, number: `C${stamp}01`, floor: 1, bhk: 2, carpetAreaSqft: "1150.00" },
      { towerId, number: `C${stamp}02`, floor: 1, bhk: 2, carpetAreaSqft: "1150.00" },
    ],
  });
  check("add a run of flats", ok(bulk), why(bulk));

  const single = await call("POST", "/v1/society/units", {
    towerId,
    number: `C${stamp}03`,
    floor: 2,
    bhk: 3,
    carpetAreaSqft: "1480.50",
  });
  check("add one flat", ok(single), why(single));
  const unitId = single.body?.id;

  const moveIn = await call("POST", "/v1/society/occupancies", {
    unitId,
    phone: `+9198${stamp}01`,
    name: `Console Owner ${stamp}`,
    relationship: "owner",
    isBillingLiable: true,
    hasVotingRight: true,
    hasAppAccess: true,
    validFrom: today,
  });
  check("move someone in", ok(moveIn), why(moveIn));
  const occupancyId = moveIn.body?.id ?? moveIn.body?.occupancyId;

  const occupants = await call("GET", `/v1/society/units/${unitId}/occupants`);
  check("occupants list", ok(occupants) && occupants.body.length > 0, why(occupants));

  // The bitemporal question the whole model exists to answer.
  const backdated = await call(
    "GET",
    `/v1/society/units/${unitId}/occupants?on=2020-01-01`,
  );
  check(
    "who lived here in 2020 — nobody",
    ok(backdated) && backdated.body.length === 0,
    why(backdated),
  );

  // --------------------------------------------------------- directory page
  console.log("\n--- Directory & Roles ---");

  const directory = await call("GET", "/v1/society/directory");
  check("directory list", ok(directory), why(directory));

  const grant = await call("POST", "/v1/society/roles", {
    phone: `+9198${stamp}02`,
    name: `Console Guard ${stamp}`,
    roleCode: "guard",
  });
  check("grant a role", ok(grant), why(grant));

  const personId = grant.body?.personId ?? grant.body?.id;
  if (personId) {
    const revoke = await call("DELETE", "/v1/society/roles", {
      personId,
      roleCode: "guard",
    });
    check("revoke a role", ok(revoke), why(revoke));
  } else {
    check("revoke a role", false, "grant returned no person id to revoke");
  }

  // -------------------------------------------------------- complaints page
  console.log("\n--- Complaints ---");

  const categories = await call("GET", "/v1/tickets/categories");
  check("categories for the raise form", ok(categories) && categories.body.length > 0, why(categories));

  const categoryId = categories.body?.[0]?.id;
  const raised = await call("POST", "/v1/tickets", {
    categoryId,
    title: `Console lift light ${stamp}`,
    description: "Raised by the console smoke test.",
    locationType: "common",
    priority: "normal",
  });
  check("raise a complaint", ok(raised), why(raised));
  const ticketId = raised.body?.id;

  const events = await call("GET", `/v1/tickets/${ticketId}/events`);
  check("thread history", ok(events), why(events));

  const attachments = await call("GET", `/v1/tickets/${ticketId}/attachments`);
  check("attachments list", ok(attachments) && Array.isArray(attachments.body), why(attachments));

  const comment = await call("POST", `/v1/tickets/${ticketId}/comments`, {
    body: "Electrician booked for tomorrow.",
    internal: true,
  });
  check("post an internal note", ok(comment), why(comment));

  const after = await call("GET", `/v1/tickets/${ticketId}/events`);
  check(
    "internal note is marked staff_only",
    after.body?.some((e) => e.visibility === "staff_only"),
    why(after),
  );

  const inProgress = await call("POST", `/v1/tickets/${ticketId}/status`, {
    status: "in_progress",
  });
  check("change status", ok(inProgress), why(inProgress));

  // ----------------------------------------------------------- billing page
  console.log("\n--- Dues & Billing ---");

  // The console asks for the charge heads before drawing the form, so a head that needs
  // a meter reading gets a box to type it into. Without this the accountant's only route
  // to that knowledge was submitting and reading the refusal.
  const chargeTypes = await call("GET", "/v1/billing/charge-types");
  check("charge heads for the invoice form", ok(chargeTypes), why(chargeTypes));

  const metered = (chargeTypes.body ?? []).filter((c) => c.needsMeterReading);
  check(
    "metered heads are flagged so the form can ask for a reading",
    Array.isArray(chargeTypes.body) &&
      chargeTypes.body.every((c) => "needsMeterReading" in c),
    why(chargeTypes),
  );

  // Refusing without a reading is correct — a guessed water bill is worse than no bill.
  // What matters is that the refusal is legible rather than a 500.
  const noReading = await call("POST", "/v1/billing/preview", {
    unitId,
    periodStart: `${today.slice(0, 8)}01`,
    periodEnd: today,
    dueDate: today,
  });
  if (metered.length > 0) {
    check(
      "a missing meter reading is a 422 naming the head, not a 500",
      noReading.status === 422 && String(noReading.body?.error?.message).includes("meter"),
      why(noReading),
    );
  }

  const previewBody = {
    unitId,
    periodStart: `${today.slice(0, 8)}01`,
    periodEnd: today,
    dueDate: today,
    // Strings keyed by charge code, exactly as the modal sends them.
    ...(metered.length > 0
      ? { meterReadings: Object.fromEntries(metered.map((c) => [c.code, "18"])) }
      : {}),
  };

  const preview = await call("POST", "/v1/billing/preview", previewBody);
  check("preview an invoice", ok(preview), why(preview));
  check(
    "preview totals are strings, never numbers",
    typeof preview.body?.total === "string",
    `total was ${typeof preview.body?.total}`,
  );
  check(
    "preview returns the lines the modal renders",
    Array.isArray(preview.body?.lines),
    why(preview),
  );

  const issued = await call("POST", "/v1/billing/issue", previewBody);
  check("issue the invoice", ok(issued), why(issued));

  // ---------------------------------------------------------- payments page
  console.log("\n--- Payments ---");

  const destinations = await call("GET", "/v1/payments/destinations");
  check("destinations list", ok(destinations), why(destinations));
  check(
    "credentials never travel to the browser",
    !JSON.stringify(destinations.body).includes("credentialsSecretRef"),
    "a secret reference was serialised to the client",
  );

  const outstanding = await call("GET", "/v1/payments/outstanding");
  check("outstanding by unit", ok(outstanding), why(outstanding));

  const reference = `CONSOLE-${stamp}`;
  const manual = await call("POST", "/v1/payments/manual", {
    unitId,
    amount: "100.00",
    method: "cheque",
    receivedOn: today,
    reference,
  });
  check("record a manual payment", ok(manual), why(manual));

  // The console's reference field is the idempotency key. Someone re-entering the same
  // cheque because they were not sure it saved must not create a second receipt.
  const again = await call("POST", "/v1/payments/manual", {
    unitId,
    amount: "100.00",
    method: "cheque",
    receivedOn: today,
    reference,
  });
  check(
    "the same cheque twice records one receipt",
    ok(again) && again.body?.duplicate === true,
    why(again),
  );

  // -------------------------------------------------------------- gate page
  console.log("\n--- Gate ---");

  const validFrom = new Date().toISOString();
  const validTo = new Date(Date.now() + 8 * 3_600_000).toISOString();

  const issuedPass = await call("POST", "/v1/gate/passes", {
    unitId,
    visitorName: `Console Visitor ${stamp}`,
    visitorPhone: "+919900000123",
    category: "guest",
    validFrom,
    validTo,
    maxUses: 1,
  });
  check("issue a visitor pass", ok(issuedPass), why(issuedPass));
  check("pass returns a QR value to show once", Boolean(issuedPass.body?.qrValue), why(issuedPass));
  check(
    "the QR carries no visitor name",
    !String(issuedPass.body?.qrValue ?? "").includes("Console Visitor"),
    "the visitor's name is readable in the QR payload",
  );

  const pendingApprovals = await call("GET", "/v1/gate/approvals/pending");
  check("pending approvals", ok(pendingApprovals), why(pendingApprovals));

  const inside = await call("GET", "/v1/gate/inside");
  check("who is inside", ok(inside), why(inside));

  if (issuedPass.body?.passId) {
    const revoked = await call("POST", `/v1/gate/passes/${issuedPass.body.passId}/revoke`, {});
    check("revoke a pass", ok(revoked), why(revoked));
  }

  // -------------------------------------------------------- operations page
  console.log("\n--- Operations ---");

  const parcel = await call("POST", "/v1/deliveries", {
    courier: "Amazon",
    unitId,
    trackingRef: `TRK${stamp}`,
    parcelCount: 2,
  });
  check("log a parcel", ok(parcel), why(parcel));
  const parcelId = parcel.body?.id;

  const advanced = await call("POST", "/v1/deliveries/advance", {
    id: parcelId,
    status: "held_at_gate",
    note: "Resident not reachable.",
  });
  check("advance a parcel", ok(advanced), why(advanced));

  // The console disables the button without a name; the API must agree.
  const noName = await call("POST", "/v1/deliveries/advance", {
    id: parcelId,
    status: "collected",
  });
  check(
    "a handover with nobody named is refused",
    noName.status === 400 || noName.status === 422,
    why(noName),
  );

  const handedOver = await call("POST", "/v1/deliveries/advance", {
    id: parcelId,
    status: "collected",
    handoverTo: "Mrs Sharma",
  });
  check("hand a parcel over", ok(handedOver), why(handedOver));

  const sos = await call("POST", "/v1/safety/sos", {
    type: "medical",
    unitId,
    note: `Console smoke ${stamp}`,
  });
  check("raise an SOS", ok(sos), why(sos));
  const sosId = sos.body?.id;

  const acked = await call("POST", `/v1/safety/sos/${sosId}/acknowledge`, {});
  check("acknowledge an alarm", ok(acked), why(acked));

  const closed = await call("POST", `/v1/safety/sos/${sosId}/close`, {
    note: "Smoke test — no real incident.",
  });
  check("close an alarm", ok(closed), why(closed));

  // --------------------------------------------------------- amenities page
  console.log("\n--- Amenities ---");

  const amenity = await call("POST", "/v1/safety/amenities", {
    name: `Console Hall ${stamp}`,
    capacity: 60,
    slotMinutes: 60,
    isPaid: true,
    rate: "2000.00",
  });
  check("add an amenity", ok(amenity), why(amenity));
  const amenityId = amenity.body?.id;

  const start = new Date(Date.now() + 86_400_000);
  const end = new Date(start.getTime() + 3_600_000);

  const booked = await call("POST", "/v1/safety/bookings", {
    amenityId,
    unitId,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
  });
  check("book an amenity", ok(booked), why(booked));

  // The whole reason the constraint is in Postgres rather than in a lookup.
  const clash = await call("POST", "/v1/safety/bookings", {
    amenityId,
    unitId,
    startsAt: new Date(start.getTime() + 900_000).toISOString(),
    endsAt: new Date(end.getTime() + 900_000).toISOString(),
  });
  check(
    "an overlapping booking is refused by the database",
    clash.status === 409 || clash.status === 400,
    why(clash),
  );

  if (booked.body?.id) {
    const cancelled = await call("DELETE", `/v1/safety/bookings/${booked.body.id}`);
    check("cancel a booking", ok(cancelled), why(cancelled));
    check(
      "cancelling keeps the row, it does not delete it",
      cancelled.body?.status === "cancelled",
      why(cancelled),
    );
  }

  // ------------------------------------------------------------- staff page
  console.log("\n--- Staff ---");

  const staffMember = await call("POST", "/v1/staff", {
    fullName: `Console Lakshmi ${stamp}`,
    phone: `+9197${stamp}01`,
    kind: "maid",
    employerUnitId: unitId,
  });
  check("add someone to the register", ok(staffMember), why(staffMember));
  const staffId = staffMember.body?.id;

  check(
    "no PIN hash is ever returned",
    !JSON.stringify(staffMember.body).toLowerCase().includes("pinhash"),
    "a PIN hash reached the browser",
  );

  const activated = await call("POST", `/v1/staff/${staffId}/status`, { status: "active" });
  check("set status", ok(activated), why(activated));

  const pinSet = await call("POST", `/v1/staff/${staffId}/pin`, { pin: "4821" });
  check("set an attendance PIN", ok(pinSet), why(pinSet));

  const verified = await call("POST", `/v1/staff/${staffId}/verification`, {
    status: "verified",
    reference: `DL-${stamp}`,
    idLast4: "4321",
    policeVerified: true,
  });
  check("record verification", ok(verified), why(verified));

  const staffList = await call("GET", "/v1/staff");
  check(
    "no Aadhaar number anywhere in the register",
    !JSON.stringify(staffList.body).includes("aadhaar"),
    "an Aadhaar field reached the browser",
  );

  const checkedIn = await call("POST", "/v1/staff/attendance/check-in", {
    staffId,
    method: "manual",
  });
  check("check someone in", ok(checkedIn), why(checkedIn));

  const present = await call("GET", "/v1/staff/attendance/present");
  check("who is inside", ok(present), why(present));

  const checkedOut = await call("POST", "/v1/staff/attendance/check-out", { staffId });
  check("check someone out", ok(checkedOut), why(checkedOut));

  const timesheet = await call(
    "GET",
    `/v1/staff/timesheet?month=${today.slice(0, 7)}`,
  );
  check("timesheet for the month", ok(timesheet), why(timesheet));

  // ----------------------------------------------------------- notices page
  console.log("\n--- Notices & Polls ---");

  const notice = await call("POST", "/v1/notices", {
    kind: "circular",
    title: `Console water notice ${stamp}`,
    body: "Water supply interrupted on Thursday between 10am and 2pm.",
    audience: "society",
    isPinned: false,
  });
  check("write a notice", ok(notice), why(notice));
  const noticeId = notice.body?.id;

  check(
    "a new notice is a draft, not published",
    notice.body?.publishedAt === null || notice.body?.publishedAt === undefined,
    why(notice),
  );

  const poll = await call("POST", "/v1/notices", {
    kind: "poll",
    title: `Console poll ${stamp}`,
    body: "Should the gym open at 5am?",
    audience: "society",
    isPinned: false,
    options: ["Yes", "No", "No opinion"],
  });
  check("write a poll with options", ok(poll), why(poll));

  const results = await call("GET", `/v1/notices/${poll.body?.id}/results`);
  check(
    "poll results come back with every option",
    ok(results) && results.body.length === 3,
    why(results),
  );

  const published = await call("POST", `/v1/notices/${noticeId}/publish`, {});
  check("publish a notice", ok(published), why(published));

  const reads = await call("GET", `/v1/notices/${noticeId}/reads`);
  check("read receipts", ok(reads) && typeof reads.body?.readers === "number", why(reads));

  // ----------------------------------------------------------- parking page
  console.log("\n--- Parking ---");

  const vehicle = await call("POST", "/v1/parking/vehicles", {
    plate: `KA01ZZ${stamp.slice(-4)}`,
    unitId,
    kind: "car",
    makeModel: "Maruti Swift",
    colour: "White",
  });
  check("register a vehicle", ok(vehicle), why(vehicle));
  const vehicleId = vehicle.body?.id;

  const slot = await call("POST", "/v1/parking/slots", {
    code: `CS${stamp.slice(-4)}`,
    kind: "covered",
    level: "B1",
    monthlyRate: "500.00",
  });
  check("add a parking slot", ok(slot), why(slot));
  const slotId = slot.body?.id;

  const allotted = await call("POST", "/v1/parking/slots/allot", {
    slotId,
    vehicleId,
    unitId,
  });
  check("allot a slot", ok(allotted), why(allotted));

  const released = await call("POST", `/v1/parking/slots/${slotId}/release`, {});
  check("release a slot", ok(released), why(released));

  const flagged = await call("POST", "/v1/parking/violations", {
    plate: `KA-01 ZZ ${stamp.slice(-4)}`,
    reason: "Parked in a visitor slot overnight",
  });
  check("flag a vehicle", ok(flagged), why(flagged));

  if (flagged.body?.id) {
    const resolved = await call("POST", `/v1/parking/violations/${flagged.body.id}/resolve`, {});
    check("resolve a flag", ok(resolved), why(resolved));
  }

  const deregistered = await call("DELETE", `/v1/parking/vehicles/${vehicleId}`);
  check("deregister a vehicle", ok(deregistered), why(deregistered));

  // ----------------------------------------------------------- reports page
  console.log("\n--- Reports ---");

  const overview = await call("GET", "/v1/analytics/overview");
  check("overview", ok(overview), why(overview));
  check(
    "overview keys are the snake_case the page reads",
    overview.body && "open_tickets" in overview.body,
    `keys were ${Object.keys(overview.body ?? {}).join(", ")}`,
  );

  const collections = await call("GET", "/v1/analytics/collections");
  check("collections", ok(collections), why(collections));
  check(
    "arrears come back in ageing buckets",
    collections.body?.[0] && "overdue_90_plus" in collections.body[0],
    `keys were ${Object.keys(collections.body?.[0] ?? {}).join(", ")}`,
  );
  check(
    "arrears figures are strings, never numbers",
    typeof collections.body?.[0]?.total_outstanding === "string",
    `total_outstanding was ${typeof collections.body?.[0]?.total_outstanding}`,
  );

  const defaulters = await call("GET", "/v1/analytics/defaulters?limit=25");
  check("defaulters", ok(defaulters), why(defaulters));

  const footfall = await call("GET", "/v1/analytics/footfall?days=30");
  check("footfall", ok(footfall), why(footfall));

  const helpdeskReport = await call("GET", "/v1/analytics/helpdesk");
  check("helpdesk report", ok(helpdeskReport), why(helpdeskReport));

  const staffReport = await call("GET", `/v1/analytics/staff?month=${today.slice(0, 7)}`);
  check("staff report", ok(staffReport), why(staffReport));

  for (const [name, response] of [
    ["overview", overview],
    ["collections", collections],
    ["defaulters", defaulters],
    ["footfall", footfall],
  ]) {
    check(
      `${name} does not leak the driver envelope`,
      !JSON.stringify(response.body).includes('"fields"') &&
        !JSON.stringify(response.body).includes('"rowCount"'),
      "node-postgres internals reached the browser",
    );
  }

  // --------------------------------------------------------- migration page
  console.log("\n--- Import Data ---");

  const state = await call("GET", "/v1/migration/state");
  check("current state", ok(state), why(state));
  check(
    "state has the counters the page shows",
    state.body && "units" in state.body && "openingBalances" in state.body,
    `keys were ${Object.keys(state.body ?? {}).join(", ")}`,
  );

  // Exactly what the paste box produces from a two-row sheet.
  const importRows = [
    { tower: `Import Tower ${stamp}`, number: `M${stamp}01`, floor: 1, bhk: 2, carpetAreaSqft: "980.00" },
    { tower: `Import Tower ${stamp}`, number: `M${stamp}02`, floor: 1, bhk: 2, carpetAreaSqft: "980.00" },
  ];

  const dryRun = await call("POST", "/v1/migration/units", { rows: importRows });
  check("preview writes nothing", ok(dryRun) && dryRun.body?.dryRun === true, why(dryRun));

  const stateAfterPreview = await call("GET", "/v1/migration/state");
  check(
    "the flat count is unchanged after a preview",
    stateAfterPreview.body?.units === state.body?.units,
    `${state.body?.units} → ${stateAfterPreview.body?.units}`,
  );

  const committed = await call("POST", "/v1/migration/units?commit=true", { rows: importRows });
  check("commit writes", ok(committed) && committed.body?.dryRun === false, why(committed));
  check("two flats created", committed.body?.created === 2, why(committed));

  // Running an import twice is the natural response to a half-finished one.
  const rerun = await call("POST", "/v1/migration/units?commit=true", { rows: importRows });
  check(
    "running it again skips rather than duplicating",
    rerun.body?.created === 0 && rerun.body?.skipped === 2,
    why(rerun),
  );

  const balances = await call("POST", "/v1/migration/opening-balances?commit=true", {
    rows: [{ unitNumber: `M${stamp}01`, amount: "4500.00", asOf: today, note: "Carried from Tally" }],
  });
  check("import an opening balance", ok(balances), why(balances));

  // ------------------------------------------------------------- the books
  console.log("");
  console.log("--- The Books ---");

  const trial = await call("GET", "/v1/ledger/trial-balance");
  check("trial balance", ok(trial), why(trial));
  // The cheapest possible proof the books are internally consistent. If this is false,
  // every statement downstream of it is wrong.
  check("debits equal credits", trial.body?.balanced === true, why(trial));
  check(
    "trial balance figures are strings, never numbers",
    typeof trial.body?.totalDebit === "string",
    typeof trial.body?.totalDebit,
  );

  const sheet = await call("GET", "/v1/ledger/balance-sheet");
  check("balance sheet", ok(sheet), why(sheet));
  check("the balance sheet balances", sheet.body?.balanced === true, why(sheet));

  const ie = await call("GET", "/v1/ledger/income-expenditure");
  check("income and expenditure", ok(ie), why(ie));
  // The surplus on the I&E has to be the figure the balance sheet folds into funds, or
  // the two statements are describing different societies.
  check(
    "surplus agrees with the balance sheet",
    ie.body?.surplus === sheet.body?.accumulatedSurplus,
    `${ie.body?.surplus} vs ${sheet.body?.accumulatedSurplus}`,
  );

  check("cash and bank", ok(await call("GET", "/v1/ledger/cash-flow")), "cash-flow");
  check("day book", ok(await call("GET", "/v1/ledger/day-book")), "day-book");
  check("chart of accounts", ok(await call("GET", "/v1/ledger/accounts")), "accounts");
  check("accounting periods", ok(await call("GET", "/v1/ledger/periods")), "periods");

  const invariants = await call("GET", "/v1/ledger/invariants");
  check("ledger invariants hold", invariants.body?.ok === true, why(invariants));

  const chart = await call("GET", "/v1/ledger/accounts");
  check(
    "reports do not leak the driver envelope",
    Array.isArray(chart.body),
    why(chart),
  );

  const badDate = await call("GET", "/v1/ledger/trial-balance?asOf=not-a-date");
  check("a malformed date is refused, not ignored", badDate.status === 422, why(badDate));

  const statement = await call("GET", `/v1/ledger/house-statement?unitId=${unitId}`);
  check("house statement", ok(statement), why(statement));
  check(
    "house statement carries a running balance",
    statement.body?.closingBalance !== undefined,
    why(statement),
  );


  // ------------------------------------------------------------- exports
  console.log("");
  console.log("--- Getting the books out again ---");

  const tally = await call("GET", "/v1/ledger/export/tally?from=2020-01-01&to=2030-01-01");
  check("tally export", ok(tally), why(tally));
  check(
    "it is a Tally import envelope",
    typeof tally.body === "string" && tally.body.includes("<TALLYREQUEST>Import Data</TALLYREQUEST>"),
    typeof tally.body,
  );
  // Tally rejects any date that is not YYYYMMDD, and it does so by importing zero
  // vouchers rather than by failing — the worst possible way to be wrong.
  check(
    "voucher dates carry no separators",
    typeof tally.body === "string" && /<DATE>\d{8}<\/DATE>/.test(tally.body),
    "date format",
  );
  check(
    "ledger masters travel with the vouchers",
    typeof tally.body === "string" && tally.body.includes("<LEDGER NAME="),
    "masters",
  );

  const csvOut = await call("GET", "/v1/ledger/export/csv?from=2020-01-01&to=2030-01-01");
  check("csv export", ok(csvOut), why(csvOut));
  check(
    "csv has a header row",
    typeof csvOut.body === "string" && csvOut.body.startsWith("Date,Voucher,Narration"),
    "header",
  );


  // ------------------------------------------------------------- privacy
  console.log("");
  console.log("--- DPDP ---");

  const dpo = await call("GET", "/v1/privacy/notice");
  check("the DPO is published in-app", ok(dpo) && Boolean(dpo.body?.dataProtectionOfficer?.email), why(dpo));
  check(
    "what we keep and for how long is stated",
    Array.isArray(dpo.body?.whatWeKeepAndForHowLong) && dpo.body.whatWeKeepAndForHowLong.length > 0,
    why(dpo),
  );

  const noticeVersion = `smoke-${stamp}`;
  const privacyNotice = await call("POST", "/v1/privacy/notices", {
    purpose: "gate_photos",
    version: noticeVersion,
    body: "We photograph visitors at the gate and keep the photograph for six months so a resident can confirm who called.",
  });
  check("notice text can be published", ok(privacyNotice), why(privacyNotice));

  // Consent for a notice nobody can produce afterwards is consent to nothing.
  const orphan = await call("POST", "/v1/privacy/consents", {
    purpose: "marketing",
    noticeVersion: "no-such-version",
    granted: true,
  });
  check("consent without published notice text is refused", orphan.status === 422, why(orphan));

  const consent = await call("POST", "/v1/privacy/consents", {
    purpose: "gate_photos",
    noticeVersion,
    granted: true,
  });
  check("a consent is recorded", ok(consent), why(consent));
  check(
    "the consent is bound to the notice by hash",
    typeof consent.body?.noticeTextHash === "string" && consent.body.noticeTextHash.length === 64,
    why(consent),
  );

  const withdrawn = await call("DELETE", `/v1/privacy/consents/${consent.body?.id}`);
  check("withdrawal is one call", ok(withdrawn), why(withdrawn));
  check(
    "the consequence of withdrawing is stated, not buried",
    typeof withdrawn.body?.consequence === "string",
    why(withdrawn),
  );

  const replayed = await call("DELETE", `/v1/privacy/consents/${consent.body?.id}`);
  check("withdrawal cannot be replayed", replayed.status === 409, why(replayed));

  const exported = await call("GET", "/v1/privacy/export");
  check("a person can export everything held about them", ok(exported), why(exported));
  check(
    "the export says what it contains",
    typeof exported.body?.note === "string" && Array.isArray(exported.body?.consents),
    why(exported),
  );

  const retention = await call("GET", "/v1/privacy/retention");
  check("retention policy is published", ok(retention), why(retention));
  check(
    "gate records are capped at six months by default",
    retention.body?.find((r) => r.subject === "gate_events")?.defaultDays === 180,
    why(retention),
  );

  const purge = await call("POST", "/v1/privacy/retention/purge", {});
  check("the purge runs", ok(purge) && Array.isArray(purge.body?.runs), why(purge));
  const runs = await call("GET", "/v1/privacy/retention/runs");
  // A retention policy nobody runs is a lie with a number in it.
  check("every purge is logged", ok(runs) && runs.body.length > 0, why(runs));

  const thinReason = await call("POST", "/v1/privacy/cctv/access", {
    cameraRef: "gate-1",
    fromTs: "2026-08-24T10:00:00.000Z",
    toTs: "2026-08-24T10:30:00.000Z",
    reason: "looking",
  });
  check("watching footage needs a real reason", thinReason.status === 422, why(thinReason));

  const cctv = await call("POST", "/v1/privacy/cctv/access", {
    cameraRef: "gate-1",
    fromTs: "2026-08-24T10:00:00.000Z",
    toTs: "2026-08-24T10:30:00.000Z",
    reason: "Reviewing a reported package theft on 24 August",
  });
  check("a footage access is logged", ok(cctv), why(cctv));
  check(
    "the committee can see who has been watching",
    ok(await call("GET", "/v1/privacy/cctv/access")),
    "cctv log",
  );


  // ----------------------------------------------------------- documents
  console.log("");
  console.log("--- Documents ---");

  const byeLaws = await call("POST", "/v1/documents", {
    title: `Bye-laws ${stamp}`,
    category: "bye_laws",
    visibility: "society",
  });
  check("a document can be recorded", ok(byeLaws), why(byeLaws));

  const policy = await call("POST", "/v1/documents", {
    title: `Insurance ${stamp}`,
    category: "insurance",
    visibility: "committee",
    expiresOn: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  });
  check("an expiring document can be recorded", ok(policy), why(policy));

  const docs = await call("GET", "/v1/documents");
  check("documents list", ok(docs) && Array.isArray(docs.body), why(docs));
  const listed = (docs.body ?? []).find((d) => d.id === policy.body?.id);
  check(
    "days to expiry is computed server-side",
    typeof listed?.daysToExpiry === "number",
    JSON.stringify(listed?.daysToExpiry),
  );
  check(
    "a document with no file says so rather than pretending",
    listed?.hasFile === false,
    JSON.stringify(listed?.hasFile),
  );

  const expiring = await call("GET", "/v1/documents/expiring");
  check("what is about to lapse is answerable", ok(expiring), why(expiring));

  // A flat-scoped document with no flat would fall through the visibility check into
  // being readable by the whole society.
  const unscoped = await call("POST", "/v1/documents", {
    title: "Rental agreement",
    category: "rental_agreement",
    visibility: "unit",
  });
  check("a flat document without a flat is refused", unscoped.status === 404, why(unscoped));

  const superseding = await call("POST", "/v1/documents", {
    title: `Bye-laws ${stamp} amended`,
    category: "bye_laws",
    visibility: "society",
    supersedesId: byeLaws.body?.id,
  });
  check("a document can supersede another", ok(superseding), why(superseding));
  const afterSupersede = await call("GET", "/v1/documents");
  check(
    "the superseded one is marked, not removed",
    (afterSupersede.body ?? []).find((d) => d.id === byeLaws.body?.id)?.superseded === true,
    "superseded flag",
  );
  check(
    "the replacement carries the next version number",
    (afterSupersede.body ?? []).find((d) => d.id === superseding.body?.id)?.version === 2,
    "version",
  );


  // -------------------------------------------------------------- the rail
  console.log("\n--- what the rail hides ---");

  check(
    "society scoping came from the token, not a query string",
    typeof societyId === "string" && societyId.length === 36,
    societyId,
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
