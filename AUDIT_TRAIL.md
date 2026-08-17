# WatchMyGate — Audit Trail

Living record of every significant decision. Any agent picking this project up should be able to
read this file and understand the full history without re-deriving it.

---

## [2026-08-13 09:00] — Scope analysis of the original brief

**WHAT:** Analysed the incoming gated-community feature brief (~150 features across 9 modules) and
converted it into a buildable plan.
**WHY:** The brief was a strong feature inventory but not executable — no sequencing, no revenue
model, and several items legally or commercially unbuildable as written.
**HOW:** Verified market and regulatory facts before planning rather than assuming. Confirmed MyGate
at 25,000+ societies, market pricing ₹3–15/flat/month, DPDP Rules notified 13 Nov 2025 with full
compliance due 13 May 2027, and that NETC FASTag for parking requires an IHMCL-authorised acquirer
bank.
**DESIGN:** Positioned migration tooling and offline gate reliability as the actual product, since at
₹3 Cr ARR for 1,000 societies this market is won on distribution and switching cost, not features.
**CODE:** `design/ROLLOUT.md`, `FEATURES.md`
**MODEL:** L5 — Claude Opus
**NEXT:** Cut list, architecture corrections.

---

## [2026-08-13 09:30] — Cut eight items from scope

**WHAT:** Removed remote vehicle immobilisation, FASTag boom barriers, dark-web monitoring, drone
dispatch; redesigned Aadhaar verification and DND messaging; deferred predictive maintenance; hard-
scoped visitor anomaly detection.
**WHY:** Each is a liability rather than a scope preference. Vehicle immobilisation can kill someone
and is uninsurable. FASTag parking is legally gated behind an authorised acquirer bank. Aadhaar
cannot be mandated by private entities since §57 was struck down.
**HOW:** Documented every cut with its reason in `FEATURES.md` rather than deleting silently, so the
decision is reviewable later.
**DESIGN:** UHF RFID replaces FASTag; alert-only replaces immobilisation; DigiLocker replaces Aadhaar
storage.
**CODE:** `FEATURES.md` — "Cut / deferred" section
**MODEL:** L5
**NEXT:** Architecture.

---

## [2026-08-13 10:00] — Architecture: modular monolith, shared schema + RLS, no MongoDB

**WHAT:** Overrode the brief's recommended microservices, schema-per-tenant and MongoDB.
**WHY:** Five services means distributed transactions across billing before product-market fit.
1,000 tenant schemas means 1,000 migrations per deploy and connection-pool explosion. ~2M gate
events/day is a well-indexed Postgres problem, not a big-data one.
**HOW:** One FastAPI deployable with lint-enforced module boundaries; shared schema with
`society_id` everywhere and Postgres RLS enforced via a `NOBYPASSRLS` application role; whale tenants
graduate to a dedicated DB through a routing table using the same code path.
**DESIGN:** Unscoped queries return zero rows rather than everything — fail closed.
**CODE:** `design/ARCHITECTURE.md` §2–3, `design/DATA_MODEL.md` §7
**MODEL:** L5
**NEXT:** Offline gate design.

---

## [2026-08-13 10:30] — Offline gate and approval ladder

**WHAT:** Designed offline-verifiable Ed25519 visitor passes, append-only outbox sync, and a timed
approval ladder replacing the brief's "approval under 2 seconds".
**WHY:** The stated 2-second target is physically impossible because the round trip includes a human
tapping a button. Separately, guards work at barriers with no connectivity, and "resident did not
answer" is the biggest real-world complaint against incumbents.
**HOW:** Server signs a compact pass; the guard app verifies locally against a cached society public
key rotated weekly, so a pre-approved visitor enters with zero network. Gate entries are events, so
they are conflict-free; sync is an ordered outbox drain keyed on client-generated UUIDv7.
Cloud Tasks scheduled delivery fires ladder rungs at 20s (IVR+SMS), 45s (unit standing rule) and 90s
(MC escalation), each cancelled if the resident responds.
**DESIGN:** Device clocks are assumed wrong — store `device_ts` and `server_ts`, compute drift, use
server time for all business logic.
**CODE:** `design/ARCHITECTURE.md` §4–5, `design/DATA_MODEL.md` §2
**MODEL:** L5
**NEXT:** Money architecture.

---

## [2026-08-13 11:00] — Payments: never hold funds (RBI PA licensing)

**WHAT:** Established that funds must never enter a WatchMyGate account, in any flow.
**WHY:** Collecting maintenance on behalf of societies through our own account requires an RBI
Payment Aggregator licence we cannot obtain.
**HOW:** Razorpay Route linked accounts settle directly to each society's bank; Smart Collect issues
per-unit virtual account numbers for automatic NEFT/IMPS/UPI reconciliation. Our SaaS fee is billed
separately as an ordinary B2B invoice.
**DESIGN:** Double-entry immutable journal with UPDATE/DELETE revoked at the database and enforced by
trigger; corrections are contra-entries. `numeric(18,4)` money. Webhooks idempotent on provider event
id.
**CODE:** `design/PAYMENTS.md`, `design/DATA_MODEL.md` §4
**MODEL:** L5
**NEXT:** Stack decisions.

---

## [2026-08-13 12:00] — Stack: adopted Krishna's proposal with four corrections

**WHAT:** Reviewed the proposed stack (Flutter · Next.js · Cloud Run Singapore · Neon · R2 · Secret
Manager · MSG91 · GLM-OCR + Claude). Kept ~70%; corrected four items; added six missing components.
**WHY:** Flutter, R2, Secret Manager, MSG91 and the single-app philosophy were all correct. GLM-OCR's
hosted API is China-hosted, which is a poor destination for society bank statements and a needless
third vendor.
**HOW:** Dropped GLM-OCR in favour of Claude alone. Split the API and workers out of Next.js because
Cloud Run terminates a container once it returns a response, so ladder timers and billing runs cannot
live in request handlers. Added FCM/APNs, Cloud Tasks, Razorpay Route, WhatsApp, Exotel and Sentry,
all of which were missing.
**DESIGN:** Next.js retained for the two admin consoles only.
**CODE:** `design/TECH_STACK.md`
**MODEL:** L5
**NEXT:** Region and database.

---

## [2026-08-13 12:30] — Region: Singapore, on Krishna's decision

**WHAT:** Kept Neon Postgres and therefore Cloud Run in `asia-southeast1` (Singapore).
**WHY:** Recommended Mumbai for DPDP residency; Krishna decided to keep Neon. Verified Neon has 8
regions (Virginia, Ohio, Oregon, Frankfurt, London, Singapore, Sydney, São Paulo) and none in India,
so compute must be co-located with it.
**HOW:** Co-located, the cost is ~40–60 ms once per request, which fits the 800 ms gate budget. The
configuration explicitly forbidden is Cloud Run in Mumbai with Neon in Singapore — that would put
every query across the sea.
**DESIGN:** Two carried risks documented rather than hidden: DPDP §16 allows the government to notify
restricted countries later, and the ledger stores payment identifiers. Mitigations: Neon → any
Postgres is a dump/restore (days, not months), and a one-off legal opinion is scheduled before the
100th society. Neon autosuspend must be disabled or the first gate entry each morning waits for the
database to wake.
**CODE:** `design/TECH_STACK.md`, `design/SECURITY_COMPLIANCE.md` §1
**MODEL:** L5
**NEXT:** Backend language.

---

## [2026-08-13 13:00] — Backend language: FastAPI / Python

**WHAT:** Chose Python + FastAPI for the API and workers, after evaluating TypeScript/NestJS.
**WHY:** Native `decimal.Decimal` maps directly from Postgres `numeric`, removing an entire class of
float rounding bug from the ledger — JavaScript has no native decimal. Python's Excel, Tally and PDF
tooling is materially better, and that is exactly the migration and reporting work identified as the
growth gate past 400 societies.
**HOW:** Considered and rejected the counter-argument that TypeScript allows sharing billing code
between server and browser. Resolved better by removing client-side money arithmetic entirely.
**DESIGN:** Money is computed server-side only; clients display what the API returns, and live totals
during editing come from `POST /billing/preview`. One implementation, so the resident's total and the
GST filing cannot differ by a paisa. Three languages deliberately: Python (backend), TypeScript
(admin consoles), Dart (mobile and desktop). The API being plain HTTP is what lets one backend serve
all client surfaces including a future Flutter Desktop build.
**CODE:** `design/TECH_STACK.md`, `design/ARCHITECTURE.md` §6
**MODEL:** L5
**NEXT:** Payment Mode 2.

---

## [2026-08-13 13:30] — Payments Mode 2: direct merchant, zero platform commission

**WHAT:** Added a second collection mode where an individual flat owner supplies their own gateway
merchant ID, so tenant rent settles into the owner's account with no WatchMyGate commission.
**WHY:** Requested by Krishna. Also strengthens the RBI position — in Mode 2 we are even further from
the money path.
**HOW:** Owner enters merchant credentials; the secret is written to Google Secret Manager and
verified by creating and voiding a ₹1 order. We orchestrate order creation against their account and
never touch funds.
**DESIGN:** Flagged that platform commission can be zero but the gateway's own MDR cannot — Razorpay
still deducts ~2% on credit cards. UPI is genuinely 0% under RBI's zero-MDR mandate, so the payment
screen defaults to UPI and the UI says "no WatchMyGate fee" rather than "free". Reconciliation
degrades without the owner configuring our webhook, so a 15-minute polling fallback plus manual UTR
entry exists; an invoice is never marked paid on the payer's word alone. TDS 194-IB (5% above
₹50,000/month rent) surfaced at payment time.
**CODE:** `design/PAYMENTS.md`, `design/DATA_MODEL.md` §4
**MODEL:** L5
**NEXT:** Phase 0 implementation.

---

## [2026-08-13 14:00] — Design documentation consolidated

**WHAT:** Wrote `design/TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`, `PAYMENTS.md`,
`SECURITY_COMPLIANCE.md`, `ROLLOUT.md`, plus root `FEATURES.md` and this file.
**WHY:** Krishna's chosen sequence was documentation first, then build. These documents are the
handoff surface for any future agent or developer.
**HOW:** Each document states decisions and the reasoning behind them, including rejected
alternatives, so choices are reviewable rather than archaeological.
**CODE:** `design/`, `FEATURES.md`, `AUDIT_TRAIL.md`
**MODEL:** L5
**NEXT:** Phase 0 — repo scaffold, migrations, RLS, tenant context, auth, cross-tenant leak test.

---

## [2026-08-13 15:00] — Phase 0 foundation built and verified

**WHAT:** Monorepo scaffold, FastAPI app, Alembic migration `0001_foundation`, Postgres RLS,
`tenant_context`, phone-OTP auth with rotating refresh tokens, money primitives, 35 passing tests,
GitHub Actions CI and a Terraform skeleton for Cloud Run/Tasks/Scheduler/Secret Manager.
**WHY:** Everything in Phase 1 depends on tenant isolation and money correctness being right first.
Both are cheap now and near-impossible to retrofit.
**HOW:** Application connects as `watchmygate_app`, created `NOBYPASSRLS` and without table
ownership, so it cannot cross tenants even when application code is wrong. Every tenant table has
`ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy. All database access goes
through one async context manager that opens a transaction and calls `set_config('app.society_id',
…, true)`; ruff bans importing the engine or session factory anywhere else.
**DESIGN:** Verified against a real Postgres, not asserted. 21 isolation tests cover both leak
directions, unscoped reads, cross-tenant writes, role attributes, audit-log immutability, and the
shared-person case (one human in both societies).
**CODE:** `apps/api/app/common/tenancy/tenant_context.py`, `alembic/versions/0001_foundation.py`,
`tests/test_tenant_isolation.py`
**MODEL:** L5
**NEXT:** Phase 1 — gate, billing and helpdesk tracks.

---

## [2026-08-13 15:10] — Two defects found by running the code, not reading it

**WHAT:** Fixed an RLS fail-open edge case and a stub-mode bypass. Both were found only by
executing against a real database and a real server.

**Defect 1 — RLS policy raised instead of filtering.**
`current_setting('app.society_id', true)` returns the **empty string**, not NULL, once a pooled
connection has previously served a scoped request — `set_config(..., is_local => true)` resets to
`''` at transaction end. A bare `''::uuid` therefore raised `InvalidTextRepresentation` rather than
filtering, so unscoped behaviour depended on whether the connection happened to be warm: an error on
a reused connection, clean zero rows on a fresh one. Fixed by wrapping in `nullif(..., '')` so both
cases collapse to NULL and the row simply fails to match. Unscoped queries now return zero rows
deterministically. `tests/test_tenant_isolation.py::test_unscoped_query_returns_nothing`.

**Defect 2 — blank credentials disabled stub mode.**
`.env.example` ships credentials as blank lines (`MSG91_AUTH_KEY=`). Pydantic loaded these as `""`
rather than `None`, so every `*_is_stubbed` check reported False and **the API made a live HTTP call
to MSG91's production endpoint** with an empty auth key during local testing. Fixed with a
`mode="before"` model validator that maps blank and whitespace-only values to `None`. Verified: the
full OTP login flow now completes in stub mode with zero external calls. `tests/test_config.py`.

**WHY THIS MATTERS:** Defect 1 is the exact class of bug the isolation suite exists to catch, and it
would have been invisible in code review. Defect 2 would have burned real SMS credits and sent real
resident phone numbers to a third party from every developer machine.
**MODEL:** L5
**NEXT:** Phase 1.

---

## [2026-08-14 10:00] — Stack changed: TypeScript owns money, Python owns machines

**WHAT:** On Krishna's direction, the API moved from Python/FastAPI to **TypeScript**. Python is
retained as a **separate service** for generative AI and external devices only (camera, ANPR, RFID,
boom barriers). Desktop is **Tauri**; the admin console is **Next.js** in static-export mode.
**WHY:** The billing calculator must produce identical results in the browser, on the server and in
the desktop app. TypeScript is the only language that runs in all three, so the calculator is written
once in `packages/money` and imported everywhere. Python cannot run in a browser.
**HOW:** `apps/api` (TypeScript/NestJS) owns the database and every financial path. `apps/ai-service`
(Python/FastAPI) has **no database access at all** — it calls the core API over HTTP with a service
token. That keeps one writer for money, one audit path, and one set of tenant-isolation plumbing;
AI and hardware code can crash or restart freely without risk to financial data.
**DESIGN:** The one hazard this introduces is that **TypeScript has no native decimal** — JS `Number`
is a float, so sharing a float-based calculator would make server and browser wrong *identically*,
which is worse than disagreeing because nothing would flag it. Closed by: `decimal.js` throughout, a
branded `Money` type so a bare `number` is a compile error, `numeric(18,4)` columns with the pg type
parser returning strings rather than floats, and a lint rule banning raw arithmetic on currency.
Flutter cannot import the package, so `packages/money/golden-vectors.json` is executed by both the
TypeScript and Dart suites — neither can drift without a red build.
**CODE:** `design/TECH_STACK.md`, `packages/money/`, `packages/db/`, `apps/api/`, `apps/ai-service/`
**MODEL:** L5
**NEXT:** Remaining API modules, worker, admin console, Tauri shell, Flutter apps.

---

## [2026-08-14 10:30] — Local Docker removed; real infrastructure only

**WHAT:** Deleted `docker-compose.yml` and the local Postgres/PgBouncer setup. All configuration now
points at placeholder Neon and Google Cloud values.
**WHY:** Krishna's decision — go straight to real infrastructure rather than maintaining a local
substitute.
**DESIGN:** Consequence stated plainly: **nothing database-backed can be executed until the real Neon
connection string is supplied.** The isolation tests, migrations and any integration test are written
and committed but unrun. Pure logic — the money calculator and billing rules — is still fully
testable, which is why the golden vectors matter more than ever. Configuration refuses to boot in
production while any value still contains the literal string PLACEHOLDER.
**CODE:** `.env.example`, `packages/db/src/migrate.ts`
**MODEL:** L5
**NEXT:** Await real credentials; continue building until then.

---

## [2026-08-15 11:00] — Landing page from the supplied design; invented proof removed

**WHAT:** Built the public landing page at `/` from `design/landing/source.dc.html`, moved sign-in to
`/login/`, and created `BACKLOG.md`.
**WHY:** The console had no public face — `/` was the sign-in form.
**HOW:** The supplied file is a design-tool export using proprietary `<x-dc>` / `<sc-for>` templating
that only that tool renders, so it is kept as the reference and reimplemented as a static React page
shipping 0 kB of page JavaScript.
**DESIGN:** Two departures, both documented in `design/landing/README.md`. Fonts are self-hosted via
`next/font/google` rather than CDN-linked, because Tauri's CSP blocks external hosts and the desktop
build would silently drop to a system sans. And the fabricated social proof was removed — "5,200+
communities", three usage statistics, six named customer logos and a signed testimonial from the
secretary of a society that does not exist. Nothing is live, so none of it is true, and the CCPA's
2022 misleading-advertising guidelines prohibit fabricated testimonials outright. Each slot now
carries a claim checkable in this repo. Pricing follows the plan's ₹8–15/flat rather than the
design's ₹29–49, which sits 2–4× above every incumbent.
**CODE:** `apps/web-admin/src/app/page.tsx`, `landing.css`, `design/landing/README.md`
**MODEL:** L5
**NEXT:** Hero carousel; Phase 2 modules.

---

## [2026-08-15 11:30] — Hero carousel, and the ceiling on image quality

**WHAT:** Replaced the hero artwork with a four-slide carousel on a glass frame.
**WHY:** Krishna supplied four images and asked for maximum quality.
**HOW:** The supplied screenshots were downscaled copies. The originals were traced through the
Stitch exports and fetched from source — **512×279 is Stitch's native output and the hard ceiling on
real detail**. `design/landing/prep_hero.py` crops the burned-in CCTV overlay text (the thinnest,
most aliased part of each frame, and the first thing to disintegrate when enlarged), resamples 2×
with Lanczos, applies a restrained unsharp mask, and emits 1× and 2× WebP served through `srcset`.
**DESIGN:** The camera chrome is redrawn as live CSS text so it stays sharp at any density, and the
fourth slide is markup rather than a bitmap because it is UI — rasterising it would discard
resolution for nothing. A competitor's brand name appeared twice in the concierge photo and is
blurred with a feathered mask so it reads as depth of field.
**CODE:** `apps/web-admin/src/components/HeroCarousel.tsx`, `design/landing/prep_hero.py`
**MODEL:** L5
**NEXT:** Real photographs of the pilot society would beat all of this and are not capped at 512 px.

---

## [2026-08-15 11:45] — A `next build` that broke the running dev server, and the fix that was worse

**WHAT:** Ran the production build while `next dev` was live; the open browser tab died with
`__webpack_modules__[moduleId] is not a function`.
**WHY:** Both commands write to `.next`, so the build replaced chunks the dev server had already
served.
**HOW:** Attempted a fix by giving the build its own `distDir`. **It does not work, and was
withdrawn.** With `output: "export"` that setting relocates the *exported* files, so `out/` stopped
being produced — the directory Tauri packages — while `.next` was overwritten exactly as before.
Measured rather than assumed; an intermediate diagnosis blaming `NODE_ENV` instability was also
wrong, disproved by instrumenting the config.
**DESIGN:** Recorded the constraint as a comment in `next.config.mjs` instead of engineering around
it. A workaround that half-works and silently breaks the desktop build is worse than a documented
constraint.
**CODE:** `apps/web-admin/next.config.mjs`
**MODEL:** L5
**NEXT:** Do not run `admin:build` while `admin:dev` is up; the repo-root `npm run build` counts.

---

## [2026-08-15 12:30] — Phase 2 schema: staff, deliveries, notices, vehicles, parking

**WHAT:** Migrations 0007 (eleven tables) and 0008 (policies), plus Drizzle definitions.
**WHY:** Six of the twelve modules advertised on the landing page had no storage at all.
**HOW:** Same split as Phase 1 — tables, then controls — because a policy on a table that does not
exist yet is the failure that split was created to fix. Every new table joined the isolation suite in
the same commit.
**DESIGN:** Three tables encode a decision rather than a shape. `staff` has no column that could hold
an Aadhaar number, because §57 was struck down and verification stores only an outcome plus a masked
last-4 — structural beats a policy document. `staff_attendance` cannot be deleted, since it is the
evidence behind someone's pay; corrections are overrides recording who and why, enforced by trigger
and revoked grant like the ledger. `dlt_templates` holds the registered TRAI category per template,
because that category decides whether a message may reach a DND number, and as a constant in the
sending code it could not. `staff_assignments` exists because a maid working six flats is the normal
case, and a single `employer_unit_id` would make payroll wrong from day one.
**CODE:** `packages/db/migrations/0007_phase2_tables.sql`, `0008_phase2_policies.sql`
**MODEL:** L5
**NEXT:** API modules on top.

---

## [2026-08-15 13:15] — Four modules, and a 500 that had been hiding every bad request

**WHAT:** Staff/attendance, deliveries, notices/polls and vehicles/parking modules. Also fixed the
exception filter.
**WHY:** Completing the advertised module list, server-first — both Flutter apps consume these APIs.
**HOW:** Verified by calling the endpoints, not by compiling them: `scripts/phase2-smoke.mjs`, 35
checks against live Neon.
**DESIGN:** Deliveries validate transitions against an explicit table and demand the recipient's name
for terminal handovers, because without it "delivered" is only an assertion. Notices bind channel to
DLT category and *refuse* a promotional SMS rather than silently dropping it — a committee that
believes residents were told is worse off than one told we cannot send. Parking turns on
`normalisePlate`, deliberately not validated against Indian plate formats since BH-series, military
and dealer plates all differ and rejecting a legitimate plate leaves someone unregistrable.
**CODE:** `apps/api/src/modules/{staff,deliveries,notices,parking}/`, `common/exception.filter.ts`
**MODEL:** L5
**NEXT:** Guard app.

> **The find worth the most was unrelated to any of those modules.** A `ZodError` had no branch in
> the exception filter, so it fell through to the 500 handler — and every controller in this codebase
> validates with `schema.parse(body)`. Any malformed field on any endpoint, including ones written
> months earlier, answered "Something went wrong. Please try again." with a stack trace in the logs.
> It blamed the server for a client error, told the caller nothing about which field to fix, and
> buried genuine faults in noise. Now 422 with the offending field paths — and deliberately not Zod's
> raw issues, which echo the received value and would put a submitted PIN or OTP into the response
> body. It typechecked and unit-tested clean; only calling the endpoints found it.
