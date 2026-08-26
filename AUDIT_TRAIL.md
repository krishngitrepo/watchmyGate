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

---

## [2026-08-15 15:00] — Backlog completed end to end

**WHAT:** SOS + amenities, committee analytics, the resident app, three console pages,
migration tooling, the AI service, and CI.
**WHY:** Krishna asked for the whole backlog completed without stopping.
**HOW:** Server-first, then clients — both Flutter apps consume these APIs, and one
codebase iterates far faster than switching stacks repeatedly. Everything verified by
calling it against live Neon rather than by compiling it.
**DESIGN:** Recorded per commit. The recurring principle: put the control in the database
where one exists. Amenity double-booking is an exclusion constraint (verified: an
overlapping booking returns 409 from the constraint, not from a lookup), attendance
cannot be deleted, the outbox cannot be deleted, the ledger cannot be edited.
**CODE:** `apps/api/src/modules/{safety,analytics,migration}`, `apps/mobile-resident`,
`apps/web-admin/src/app/{staff,operations,notices}`, `apps/ai-service/app/modules`,
`.github/workflows/ci.yml`
**MODEL:** L5
**NEXT:** Razorpay test-mode proof (blocked on credentials), then both apps on real
hardware.

> **Four things were found broken that nobody had noticed, all by running code rather
> than reading it.**
>
> **The AI service could never start.** `app/main.py` was still the old Python API's
> entrypoint, importing `app.common.db` and `app.modules.auth.router` — neither of which
> has existed since the API moved to TypeScript — and its readiness probe opened a
> database connection the service has no reason to hold. `tests/conftest.py` was the same
> vintage, seeding two societies against a docker-compose Postgres that was deleted.
> Calling it "a skeleton" in the backlog was too generous.
>
> **`service_token` did not exist in the Python config.** The TypeScript API has carried
> `SERVICE_TOKEN` and an `/internal/` branch expecting it for weeks; the Python side had
> no field to compare against. The two halves of that boundary had never been connected.
>
> **Analytics assumed a `sla_breached_at` column and an invoice status of `cancelled`.**
> Neither exists. Deriving the breach from `sla_due_at` turned out better than the column
> I imagined — it also counts tickets resolved *after* the deadline, which a flag set only
> by the sweep would have missed. Open-ticket counts were also omitting `reopened`,
> exactly the tickets a committee most wants to see.
>
> **Every raw-SQL endpoint was returning node-postgres' whole envelope** — `command`,
> `rowCount`, and a `fields` array carrying each column's internal type OID. That
> publishes the driver, the column types and the query shape to any client for no benefit.
>
> A fifth was self-inflicted: the CI secret scanner's first version failed on
> `.env.example`, a file that exists precisely to show the shape of a connection string.
> A scanner that flags its own documentation gets switched off within a week.

---

## [2026-08-17 20:30] — The console learns to write

**WHAT:** Rebuilt `apps/web-admin` on the landing page's visual language and gave every
page its write paths. Fourteen screens: Today, Reports, Dues & Billing, Payments,
Complaints, Notices & Polls, Amenities, Gate Log, Operations, Parking, Flats & Residents,
Directory & Roles, Staff, Import Data. Five of those did not exist before.

**WHY:** Asked whether the internal pages were built, the honest answer was no — and the
finding was worse than a missing page. The console was a **read-only viewer over a
complete API**: eight screens, 107 endpoints behind them, and the only write in the whole
application was the login form. A committee could watch their society through it but
could not operate it. Every action — issue an invoice, acknowledge an alarm, move a
tenant in, publish a notice — still required an HTTP client.

**HOW:** Retheme first, then one page at a time, then verification by calling. The theme
moved from the ruled-register aesthetic to the landing page's warm paper, maroon and gold
with Bricolage Grotesque over Manrope, keeping only the parts of the old design that were
load-bearing rather than decorative: money in tabular figures, right-aligned; one colour
reserved for arrears; a single settle animation and nothing else moving.

**DESIGN:** Decisions worth recording, each of which was a judgement rather than a
default.

- **Roles ride in the session.** `session.roles()` and `can()` decide whether an action is
  offered at all, so a treasurer is not shown an Import button that always 403s. This is
  explicitly *not* a security boundary — the API rechecks every role on every request, and
  a token edited in devtools buys nothing but a different error message.
- **Preview is a mandatory step before issuing an invoice, and any edit voids it.**
  Approving figures computed for a different period is the one mistake that screen must
  make impossible.
- **Resolving a complaint requires a proof-of-fix photo to already be attached.** A
  "resolved" with no evidence is how a lift stays broken for three weeks while the ticket
  says otherwise.
- **Drafting and publishing a notice are separate actions.** Once sent it has reached four
  hundred phones and cannot be recalled.
- **Move-out end-dates an occupancy; it never deletes one.** "Who was liable in June?" has
  to keep answering after the tenant has gone.
- **`useAction` is the only way a write happens.** It disables the control in flight so a
  double tap cannot issue two invoices, surfaces the API's own sentence rather than
  "something went wrong", and leaves the form populated on failure.
- **Bars are drawn by hand, not by a charting library.** Every figure on a committee
  report has to read as a number as well as a shape, and 60 KB of bundle to draw eight
  rectangles is a poor trade on a society's connection.
- **The import screen matches column names.** `Flat No`, `Block`, `Owner Name` and the
  rest are recognised, because a society exporting from Tally or a competitor will not
  rename columns first — that is where migrations get abandoned. Tabs are tried before
  commas, since a rupee amount written `1,23,456.00` would otherwise split into three
  columns and corrupt every row silently.

**CODE:** `apps/web-admin/src/app/globals.css` (rethemed), `src/components/Shell.tsx`
(`Modal`, `Field`, `Check`, `Tabs`, `Bar`, `Banner`, `Form`, `useAction`), all fourteen
`page.tsx` files, `src/lib/api.ts` (`can`, roles in session),
`apps/api/src/modules/billing/*` (charge-types endpoint),
`apps/api/src/common/exception.filter.ts` (`BillingError` branch),
`scripts/console-smoke.mjs`.

**MODEL:** L5

**NEXT:** Attachment upload from the console; ledger reporting endpoints (trial balance,
P&L) which do not exist yet in any form; then Razorpay test-mode proof, still blocked on
credentials.

> **Two defects surfaced the moment a page called the API, and both had been latent for
> weeks because nothing had ever called it.**
>
> **`/v1/billing/preview` answered 500 for every unit in the seeded society.** The cause
> was a `BillingError` from the money package — *"Cannot bill 'Water charge': no meter
> reading for this period"* — falling through to the generic handler and arriving as
> "Something went wrong. Please try again." That message names exactly what the accountant
> has to supply, and it was being thrown away for a sentence that blames the server. This
> is the same class of bug as the `ZodError` → 500 found in the previous pass, in the same
> filter; one more error type that nothing had ever exercised.
>
> **The console could not have known to ask for a meter reading.** There was no endpoint
> listing charge heads, so the only route to that knowledge was submitting a preview and
> reading the refusal — which, until the above was fixed, said nothing. Added
> `GET /v1/billing/charge-types`, returning `needsMeterReading` and `needsManualAmount`
> per head and deliberately omitting `accountId`, since which ledger account a charge
> posts to is not the browser's business.
>
> Both were invisible to `tsc` and to 377 unit tests. They were visible on the first call.
> `npm run e2e:console` now sends the exact request bodies the pages send — 93 checks,
> including that the same cheque number twice records one receipt, that an overlapping
> amenity booking is refused by Postgres rather than by a lookup, that a parcel handover
> with nobody named is rejected, that a preview import leaves the flat count unchanged,
> and that no PIN hash, Aadhaar field or driver envelope ever reaches a browser.

---

## [2026-08-17 22:10] — MyGate analysed; packaging cut to Basic and Pro

**WHAT:** Read the two MyGate documents supplied (a 9-page SaaS brochure and a 120-page
February 2026 sales deck) plus the notes from a real sales call, extracted the full
feature inventory, compared it against what WatchMyGate actually has, and packaged the
result into two plans. Three deliverables: `design/COMPETITOR_MYGATE.md`,
`design/PLANS.md`, and 50 new backlog IDs (N-1 … N-50).

**WHY:** Krishna supplied the three-tier module list (Standard / Prime / Elite) and asked
for a gap analysis and for everything to be brought into Basic and Pro plans.

**HOW:** Text extracted with pdfplumber rather than read as images — the deck is 120 pages
and the feature content is all text. Every "we have this" claim was then checked against
the schema and the modules rather than asserted from memory; several first guesses were
wrong (`document` in the schema is an attachment *kind*, not a repository; expense
accounts exist in the chart of accounts but nothing reports on them).

**DESIGN:** Three decisions worth recording.

**Two plans, not three.** MyGate splits gate / community / accounting. A society buying
their middle tier is still running its money in Tally, which means the middle tier mostly
exists to make the top one look reasonable. The real decision a committee makes is binary:
*do we want this to run the gate, or to run the society?* So Basic takes their Standard
**and** most of Prime; Pro adds the money.

**Priced per flat with an annual ceiling.** The most commercially important fact in the
folder is that MyGate prices **per society, flat** — ₹28k/₹32k/₹42k a year regardless of
size. At the quoted 171-villa community that is ₹13.6–20.5 per unit per month; at 800
units the same fee is ₹2.92–4.38. Large societies get a bargain, small ones subsidise it.
Pricing purely per flat would beat them at 171 units and lose badly at 600, so: tapered
per-flat rates with a hard annual ceiling (₹24,000 Basic, ₹36,000 Pro). That undercuts
them at every size — verified arithmetically, not asserted. It costs 3–4 points of gross
margin (70–74% rather than the plan's 72–78%), and that is the right trade: onboarding
cost and support load are nearly flat with society size, so charging more for flats that
cost no more to serve is how a price becomes a reason to leave.

**Two features refused, in writing.** MyGate's deck lists blocking visitor approvals, gate
passes, move-in/out and *complaint logging* until arrears are cleared. Withholding the
party hall is fine; using the gate as a debt-collection lever against a household — one
that may be behind for reasons a committee knows nothing about — is not. Recorded as N-48
so a later pass does not "fix" the omission. Also N-49: their brochure sells an advertising
engine, lift posters, standees, gate signage and sampling kiosks *two pages after* a page
headed "Your data doesn't interest us". Our landing page already commits to neither, and
that promise appreciates the longer they run both pages in one brochure.

**CODE:** `design/COMPETITOR_MYGATE.md`, `design/PLANS.md`, `BACKLOG.md` §7c and a rewritten
critical path.

**MODEL:** L5

**NEXT:** N-1 (trial balance, P&L, balance sheet) is now the top item on the critical path,
ahead of everything except the credential-blocked Razorpay proof.

> **What the comparison actually showed.**
>
> The gap is almost entirely in the **ERP**, and almost none of it is foundational. Every
> financial report MyGate sells — trial balance, P&L, balance sheet, house statement, cash
> flow — is derivable from `journal_lines` today. What is missing is endpoints and pages,
> not a data model. That is the cheapest large gap in the product and it is now item 1.
>
> Where we are ahead is narrower but harder to copy: the gate works with no network, and
> the controls are in Postgres rather than in application code. Their 3-minute "soft
> block" for high-demand amenities is an application-level mitigation for exactly the race
> our exclusion constraint makes impossible — a good illustration of the difference.
>
> And one number worth keeping: their notes show a ₹5.9–11 platform fee charged to the
> **resident** on each payment. For a 171-unit society paying monthly that is roughly
> ₹22,500 a year taken from residents on top of the licence, and it appears on no slide in
> 120 pages.

---

[2026-08-25 08:40 IST] — INVOICE AND RECEIPT PDFs (MG-5, and the footer half of MG-12)

**WHAT:** A PDF writer (`apps/api/src/common/pdf.ts`), amounts in words in the Indian
system (`packages/money/src/words.ts`), and the two documents a society actually hands out
(`apps/api/src/modules/billing/documents.service.ts`). Plus the listings that had to exist
for either to be reachable — `GET /v1/billing/invoices` and `/receipts` — and a Download
button on the billing and payments pages.

**WHY:** A resident who cannot download a receipt does not believe they paid. That is not
a screen problem: the receipt is what gets forwarded to a spouse, attached to an email
about a disputed dues notice, and shown to a buyer during a flat sale two years later. It
has to outlive this application. The same argument runs the other way for an invoice — a
society that cannot hand its chartered accountant a stack of PDFs at year end will keep
issuing bills in Word, and then the books here and the bills on the noticeboard disagree.

**HOW:** PDF 1.4 written by hand rather than through a library. Three reasons, in order of
weight. **Size** — base-14 fonts are in every viewer, so nothing is embedded and an
invoice is ~3.4 KB against 40-80 KB from a library that subsets a TrueType face; a
thousand societies issuing 250 invoices a month is 250,000 documents. **Determinism** —
the bytes are a pure function of content and creation date, so tests can assert on them.
**No dependency** — nothing to audit or patch, no native build step on Cloud Run.

The one real trap is the rupee sign. U+20B9 is not in WinAnsiEncoding and base-14
Helvetica has no glyph for it, so emitting it gives a blank box or a silently dropped
character — on the one character an invoice cannot afford to lose. `encode()` rewrites it
to `Rs.`, which is what printed Indian invoices have always used. A smoke check asserts
the byte sequence never reaches a page.

**DESIGN:** Amounts are set in Courier, deliberately: a column of figures that lines up
digit-for-digit is easier to check by eye, and an accountant checks by eye. The Adobe
Core 14 width tables are in the module because right-aligning a proportional face requires
measuring the string before drawing it.

`amountInWords` is in the money package rather than the API because it is money
presentation, and because Indian grouping — crore, lakh, thousand — cannot be borrowed
from a generic library without producing "one hundred twenty-three thousand" where the
society's books say "one lakh twenty-three thousand". It is not decoration: a receipt
without the amount in words is not a receipt an Indian auditor recognises, for a reason
older than the software — a figure can be altered with a pen and a sentence cannot.

**Access is the part that had to be right.** A resident downloads their own flat's
documents and nobody else's, and the predicate is evaluated in SQL against their own
occupancies, never against a parameter they send — the same rule the document repository
uses. A society-level receipt with no flat attached belongs to the committee, so the
predicate excludes it for a resident rather than treating a null unit as public.

**CODE:** `apps/api/src/common/pdf.ts` (`Pdf`, `encode`, `textWidth`),
`packages/money/src/words.ts` (`amountInWords`, `numberToIndianWords`),
`apps/api/src/modules/billing/documents.service.ts`
(`BillingDocumentsService.invoice`, `.receipt`, `.listInvoices`, `.unitPredicate`),
routes in `billing.controller.ts`.

**MODEL:** L5

**NEXT:** MG-12's other half — the penalty report — then MG-11 advance and credit
balances, MG-6 budget vs actual, MG-7 asset register.

> **Three things running it found that compiling it did not.**
>
> A migrated society's invoice number is `OPEN-M82102601-2026-08-25`, and the top-right
> fact block printed it straight through its own label. The fix measures the pair and
> drops the value to its own line when it will not fit — which is the general answer, not
> a wider column that the next long value overruns anyway.
>
> An imported opening balance has no invoice lines, so the table rendered as a header over
> nothing, which reads as a rendering fault rather than as the truth about the data. It
> now says so in words.
>
> And a check I wrote asserting the receipt would warn "not yet confirmed against the
> bank" was simply wrong about the domain: `/v1/payments/manual` is the accountant
> asserting they have seen the money, so that receipt is confirmed and must not carry the
> warning. The warning path exists for a resident-supplied UTR, which is a claim. The
> check now asserts the opposite, and that the bank reference is printed so an auditor can
> trace it.
>
> Independently verified: `pypdf` — installed into the scratchpad, never into this repo —
> opens both documents, reads the metadata title, and extracts the text intact including
> a society name containing brackets.

---

[2026-08-25 08:50 IST] — CREDIT BALANCES AND THE PENALTY REPORT (MG-11, MG-12)

**WHAT:** `PaymentsService.creditBalances()` and `.applyAdvances()/.applyAdvancesIn()`,
`GET /v1/payments/credits`, `POST /v1/payments/credits/apply`, a sweep inside
`BillingService.issue`, `ReportsService.penalties()` behind `GET /v1/ledger/penalties`,
and both surfaced in the console.

**WHY:** This product could answer "who owes us" and could not answer "whom do we owe" —
and a society always owes somebody. A flat pays a round ten thousand against seven
thousand of bills; an owner settles the year in April. The money sat on the receipt
unallocated, and next month's invoice went out marked fully outstanding to somebody whose
money the society was already holding. Then a reminder followed.

**HOW:** The ledger already had it right — `recordPayment` credits receivable 1200 for the
whole receipt whether allocated or not, so the unit's account was genuinely in credit.
Nothing showed it and nothing swept it. `creditBalances()` answers arrears and credit in
one query rather than two, because they are the same number with a different sign and
computing them separately is how they come to disagree.

**The sweep posts no journal entry, and that is correct rather than an omission.** The
receipt already debited bank and credited the unit's receivable when it was taken; an
allocation records only *which* invoice a payment answers. Posting again would
double-count the money — the exact bug that stops a set of books balancing, and the reason
allocation lives in a sub-ledger. A smoke check runs the invariants after a sweep to prove
it.

**DESIGN:** The sweep runs in the *caller's* transaction, which is why it is split into
`applyAdvancesIn(db, ...)` and a `tx()`-wrapping `applyAdvances()`. Under Neon's
transaction-mode pooler a nested `tx()` is a different connection and a different
transaction, so a failed sweep would have left the invoice issued and the credit stranded.
Oldest receipt first and oldest due date first: the convention residents expect, and the
one that minimises their own late fees — newest-first would quietly maximise the interest
charged to our customers.

Idempotent by construction rather than by a flag: it can only allocate what is unallocated
to what is unpaid, so a second run finds nothing. That is asserted.

The penalty report separates **charged** from **collected**, and prints the rule that
produced the charges alongside them. A committee deciding whether to waive a fee needs to
know which of the two it is looking at, and a late fee shown without its rule is the most
common cause of a maintenance dispute — the arithmetic ends up being reconstructed by hand
in a WhatsApp group. A part payment does not count as recovering the penalty: a receipt
applies to the invoice as a whole, so the fee counts as collected only once the invoice is
settled.

**CODE:** `apps/api/src/modules/payments/payments.service.ts`
(`creditBalances`, `applyAdvances`, `applyAdvancesIn`),
`apps/api/src/modules/billing/billing.service.ts` (`issue`, now returning `creditApplied`),
`apps/api/src/modules/ledger/reports.service.ts` (`penalties`).

**MODEL:** L5

**NEXT:** MG-6 budget vs actual by head, MG-7 asset register, then the gate block —
MG-20 patrols, MG-21 kids checkout, MG-22 digital register, MG-26 offline emergency
contacts.

> Four checks I wrote failed on the first run, all four because they hard-coded the
> answer: the July bill came to Rs. 4,554.50 against a Rs. 5,000 credit, so the sweep
> applied the whole bill and left Rs. 445.50 — exactly right, and not what a test
> asserting "5000 was applied" expects. Rewritten to assert the relationship rather than
> the figure, which is the only form that survives a change to this society's charge
> heads.

---

[2026-08-25 08:58 IST] — BUDGET AND VARIANCE (MG-6)

**WHAT:** Migration `0011_budgets.sql` (`budgets`, `budget_lines`, two triggers, RLS),
`BudgetService`, five endpoints under `/v1/ledger/budgets`, and a new console page at
`/budget/`.

**WHY:** A society passes an annual budget at its AGM, head by head, and then spends the
year wanting to know one thing: are we inside it. Today that lives in a spreadsheet on the
treasurer's laptop and leaves with them when the committee turns over — which is the same
failure the document repository was built for, applied to money.

**HOW — the two things it deliberately does not do.**

**It does not store actuals.** Every actual is read from `journal_lines` at query time. A
budget table carrying its own copy of what was spent drifts from the ledger, and the
moment it does the committee has two numbers and no way to tell which one is the
society's. This page and the Income & Expenditure statement therefore cannot disagree.

**It does not let an approved budget be edited.** `budget_lines_frozen_when_approved()` is
a trigger, not a service check, because a control that only holds while the calling code
is correct is not a control — the smoke test proves an admin with every role the endpoint
asks for still cannot edit a passed budget. Approval is also one-way: draft → approved →
superseded, never back, because "unapprove, edit, re-approve" is the same edit taken the
long way round. A real change is a **revision** that supersedes and starts as a copy of
what it replaces — a revision that made you retype forty heads is one nobody raises, and
the committee would edit the old one instead.

**DESIGN:** *The person who drafted a budget cannot pass it.* A budget where the treasurer
both writes and approves is not a committee decision, it is a memo. Same rule as reopening
a locked accounting period, and passing one requires the resolution it was passed under to
be recorded.

*The variance report includes heads that were spent on but never budgeted*, flagged. A
report that only walks the budget lines answers "did we overspend what we planned" and
misses "what did we spend that we never planned at all" — the more interesting question,
and the first one an auditor asks. Those rows report `percentUsed` as **null rather than
zero**: 0% consumed of a head that was never budgeted is a lie, and it is the row that
matters most.

*The report also states how far through the year we are.* "62% of the maintenance head is
gone" is alarming in June and unremarkable in February. Showing consumption without the
elapsed year invites the wrong reaction at an AGM.

One unique index does real work: `uq_budget_year_live` allows only one budget per
financial year in `draft` or `approved`. Superseded ones fall out of it, so history
accumulates without "the budget" ever stopping being a thing anyone can point at.

**CODE:** `packages/db/migrations/0011_budgets.sql`,
`apps/api/src/modules/ledger/budget.service.ts`,
`apps/web-admin/src/app/budget/page.tsx`.

**MODEL:** L5

**NEXT:** MG-7 asset and inventory register, then the gate block — MG-20 patrols, MG-21
kids checkout, MG-22 digital register, MG-26 offline emergency contacts.

> Ten checks failed on the first run and all ten were one defect in the *test harness*:
> `callAs` did not forward a request body, so passing the budget arrived with no
> resolution reference and everything downstream cascaded off a budget that was still a
> draft. Worth noting because the ten red lines looked like a broken feature and were a
> missing parameter.
>
> The eleventh was real and more interesting: the test picks an unused far-future
> financial year so reruns do not collide with the one-live-budget-per-year index — which
> means no journal entry ever falls inside it, so "spent but never budgeted" could not
> appear. That row is now proven against the current financial year, which has real
> postings in it.

---

[2026-08-25 09:20 IST] — THE ASSET AND MAINTENANCE REGISTER (MG-7)

**WHAT:** Migration `0012_assets.sql` (`assets`, `asset_maintenance`, one trigger, RLS),
`AssetsController` with nine endpoints, a console page at `/assets/`, and fourteen new
database-level control tests in `isolation.test.ts`.

**WHY:** On every RFP, and for a reason that is not about inventory. What a committee
loses when the register lives in one facility manager's head is not the list. It is
knowing which lift is under AMC and until when on the morning it stops between floors,
that the DG service was due in March and nobody noticed until the June outage, the
fixed-asset schedule the auditor asks for every year, and what the outgoing committee
actually handed over.

**HOW:** Two tables. `assets` is what the society owns; `asset_maintenance` is the work —
due, overdue or done — because a register without a schedule attached is a list nobody
opens twice. The console page opens on **what is due** rather than on the register, for
the same reason: the reason to open it is the work.

AMC expiry sits on the same list as overdue maintenance, because from a committee's point
of view they are one problem: something is about to stop being covered.

**DESIGN — the parts that are decisions rather than fields.**

*A completed job is final, by trigger.* This log is what a society produces when a lift
injures somebody and the question is whether it was serviced. A log whose entries can be
edited afterwards proves nothing, and the temptation to tidy it up arrives exactly when it
matters most. Notes can still be added — recording what was found is not restating what
happened, and a log nobody can annotate is a log people keep somewhere else.

*The register itself stays editable*, deliberately and unlike the log. A facility manager
correcting a serial number they mistyped must not be pushed back to a spreadsheet.

*A recurring job schedules its successor from the due date, not from today.* A service
done three weeks late must not push every future service three weeks later for ever.

*Depreciation is computed, never stored*, and the payload says which method it used. A
stored written-down value drifts the moment somebody edits a cost or a life. And a
co-operative society's auditor may use the written-down-value method, so the report states
its basis in words — a figure of ours read next to theirs, unlabelled, is worse than no
figure. Assets with no expected life are carried at cost and **counted separately**, so
the omission is visible rather than silently rolled into a total.

*A retired asset is never deleted*; only its outstanding work is. What the society used to
own and what happened to it is exactly the question a handover argument turns on.

*Who reads it:* the committee, the accountant, the auditor and maintenance staff. Not a
guard — a guard reports a broken pump through the helpdesk, which routes it; they have no
use for a plant register and no reason to hold one on a society-owned handset that changes
hands every shift. Costs are blanked for staff rather than the row withheld: a technician
needs to find the pump, not to know the society paid four lakh for it.

**CODE:** `packages/db/migrations/0012_assets.sql`,
`apps/api/src/modules/assets/assets.controller.ts`,
`apps/web-admin/src/app/assets/page.tsx`, `packages/db/src/isolation.test.ts`.

**MODEL:** L5

**NEXT:** The gate block — MG-20 guard patrolling, MG-21 kids checkout, MG-22 digital
register with Excel export, MG-26 offline emergency contacts.

> **A defect I introduced and caught by running everything.**
>
> The new control tests disable the budget and maintenance triggers during teardown, the
> way the existing ledger tests do — because those controls hold against the table owner
> too, which is the point. I wrote the `DISABLE` and forgot the matching `ENABLE`.
>
> `ALTER TABLE ... DISABLE TRIGGER` is DDL and persists. So a green database suite left
> the budget freeze switched off on the live database, and the next console smoke run
> reported that an approved budget could be edited — a control absent in the actual
> infrastructure while every test claiming it stayed green. Fixed, both triggers restored
> and verified through `pg_trigger`, and the teardown now carries a comment saying why
> every DISABLE needs its ENABLE.
>
> Two smaller ones: `current_date + $1` is a 500 rather than a helpful error because
> Postgres cannot infer the parameter's type, and depreciation rounded to four decimals
> against a cost stored at four made cost minus depreciation differ from the written-down
> value by a paise. Rounded to two, where anyone will actually check it.

---

[2026-08-26 07:10 IST] — THE AUDIT LOG, ACTUALLY WRITTEN (MG-45), AND THE GATE REGISTER (MG-22)

**WHAT:** `AuditService`, audit writes on eleven acts across six modules, `/v1/audit`
behind `AuditController`, a console page at `/audit/`, `RegisterService` with
`/v1/gate/register` and its CSV export, the register on the gate page, and migration
`0013_discard_draft_budget.sql`.

**WHY — the part that was actually wrong.**

`audit_log` has existed since migration 0001: partitioned by month, `INSERT` and `SELECT`
granted to the application role, `UPDATE` and `DELETE` deliberately withheld so a
compromised application cannot rewrite history. All of that was correct, and **nothing had
ever written to it.** I checked before building the viewer: zero rows.

That is worse than not having the table, because two things already leaned on it. The
backlog described the log as "immutable and complete" — it was immutable and empty. And
`LedgerService.reopenPeriod` carried a comment saying reopening "leaves an audit record
naming both", which it did not; the controller's comment went further and said the reason
travelled to "the audit middleware", which does not exist. Worst of the three: the DPDP
erasure response tells a person, in writing, that their audit records are retained under
s.8(7) because they are "required to demonstrate compliance, including with this Act" — a
statutory claim resting on an empty table.

**HOW:** `record(db, entry)` takes the caller's transaction rather than opening its own.
Under Neon's transaction-mode pooler a nested `tx()` is a separate connection and a
separate transaction, so an audit row written that way could survive a rolled-back action
— a log claiming something happened that did not. `recordSafely()` exists for the one case
where the trade runs the other way: failing to log must not fail an export the user is
waiting on.

**What gets logged, and what deliberately does not.** Acts of authority (role granted or
revoked, budget passed or revised, period locked or reopened, pass revoked, asset retired,
document removed), money leaving its normal path (a receipt taken outside the gateway, a
credit swept), and bulk reads of personal data (the visitor register exported, a person's
record exported, an erasure completed). **Ordinary reads are not logged.** A log that
records everything is a log nobody can search, and it becomes the thing people mute rather
than the thing they consult.

**DESIGN — the register (MG-22).** `gate_events` records entries and exits separately,
which is right for the gate and wrong for the register. A register line is what the paper
book has always been: one visitor, time in, time out, still inside if the second column is
blank. So it pairs the two events back into one row.

Two columns the paper book never had: **which guard**, by name — the book has a signature
nobody can read and everybody shares — and **device clock drift**, shown rather than
hidden, because "the app says 14:05 and the book says 16:30" is the dispute this exists to
settle.

The export is CSV with a **UTF-8 byte-order mark**, which is load-bearing: without it Excel
on Windows reads the file as the local code page and a visitor called Sreeja arrives as
mojibake, which is how a committee stops trusting the export. Fields beginning `=`, `+`,
`-` or `@` are prefixed with an apostrophe — CSV injection, in a file populated entirely by
strangers typing at a guard.

And the export **requires a stated reason**, in the API and in the interface, and writes it
to the audit log. Four hundred residents' movements with names, phone numbers and vehicles
in one file is a disclosure, not a read. Same treatment as CCTV footage, for the same
reason.

**CODE:** `apps/api/src/common/audit.service.ts`,
`apps/api/src/modules/audit/audit.controller.ts`,
`apps/api/src/modules/gate/register.service.ts`,
`apps/web-admin/src/app/audit/page.tsx`, `apps/web-admin/src/app/gate/page.tsx`.

**MODEL:** L5

**NEXT:** MG-20 guard patrolling, MG-21 kids checkout, MG-26 offline emergency contacts.

> **A trap the tests walked into, which a society would have walked into first.**
>
> Migration 0011 withheld `DELETE` on `budgets` entirely — a budget the AGM passed is the
> record of a decision. Right about a passed budget, wrong about a draft, and combined
> with the one-live-budget-per-year index it produced this: a treasurer starts a draft for
> 2027-28, never finishes it, and **nobody can ever raise a budget for that year again.**
>
> The smoke test found it by walking forward one financial year per run to avoid the
> index, and eventually hitting the 2100 ceiling on `ck_budget_year`. A contrived route to
> a problem a real society reaches the first time somebody abandons a draft. Migration
> 0013 grants `DELETE` back behind a trigger that permits it only for a draft, and the
> test now reuses one year and clears up after itself.
