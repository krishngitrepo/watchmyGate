# WatchMyGate — Backlog

Everything left to build, in the order it should be built. Status here is deliberately
conservative: **Done** means it exists *and* is proven by a test that would fail if it
broke. Code that exists but has never been exercised against the real dependency is
**Unproven**, not Done — that distinction is the whole point of this file.

Counts as of the last update: **294 unit tests** (db 173, money 55, api 53, worker 13) and
**45 end-to-end checks**, green against live Neon.

Legend — **Done** · **Unproven** (built, never exercised for real) · **Partial** ·
**Todo** · **Blocked** (needs a credential from Krishna)

---

## 0. The critical path

If nothing else gets done, this is the order. Each line is the highest-value thing
available once the line above it is finished.

| # | Item | Why it is next | Backlog ref |
|---|---|---|---|
| 1 | **Guard app** (Flutter) | Highest risk left, and the one thing no competitor does cleanly. Everything it depends on server-side is built and tested. | [G-1 … G-9](#1-guard-app-appsmobile-guard) |
| 2 | **Razorpay test-mode proof** | The money path is written but has never taken a real signed webhook. Cheapest possible discovery of a very expensive bug. | [P-1 … P-5](#5-payments-proving-the-money-path) |
| 3 | **Resident app** (Flutter) | Far more feature surface, far less risk. Without it, residents cannot approve anyone. | [R-1 … R-10](#2-resident-app-appsmobile-resident) |
| 4 | **Migration tooling** | Decides whether a 400-flat society can actually switch. Commercially the highest-leverage item in this file. | [M-1 … M-6](#8-migration-tooling-the-moat) |
| 5 | **AI service** | Voice complaints and OCR. The only part of the Python/TypeScript split that is not yet real. | [A-1 … A-7](#6-ai-service-appsai-service) |

---

## 1. Guard app (`apps/mobile-guard`)

Does not exist. This is the largest gap in the product.

The security posture differs from the resident app on purpose: guard handsets are
society-owned, shared between shifts, and frequently cheap Android hardware. They must not
retain resident PII past a shift.

| ID | Task | Status | Notes |
|---|---|---|---|
| G-1 | Flutter project, Android-first, `--flavor guard` | Todo | Min SDK 21 — guards run old hardware |
| G-2 | Drift/SQLite store under SQLCipher, key in Android Keystore | Todo | Encrypted at rest; the device leaves the society sometimes |
| G-3 | Append-only outbox with client-generated UUIDv7 keys | Todo | Server dedups on this; `gate_events.id` already has no default for exactly this reason |
| G-4 | Ordered sync drain with exponential backoff | Todo | Must never wedge on one bad row — mirrors `gate.service.ts` `sync()` |
| G-5 | **Ed25519 pass verifier in Dart** | Todo | Must match `apps/api/src/modules/gate/passes.ts` byte for byte |
| G-6 | Cached society public key, weekly rotation, offline grace | Todo | Verification cannot require network — that is the whole feature |
| G-7 | Entry capture: photo, purpose, category, vehicle | Todo | Photo compressed on device, uploaded to R2 on sync |
| G-8 | Shift handover + PII purge on shift end | Todo | Resident details must not survive the guard who saw them |
| G-9 | **Airplane-mode test**: scan → admit < 500 ms; reconnect → exactly one row after 3 replays | Todo | Plan §11 test 2. This is the acceptance test for the whole app |
| G-10 | Dart golden-vector runner for money formatting | Todo | Proves Dart and TypeScript agree — `packages/billing/golden-vectors.json` |
| G-11 | Guard tools: patrol check-ins, incident log, shift log | Todo | Feature 5 on the landing page |
| G-12 | SOS receive + acknowledge | Todo | Pairs with R-8 |
| G-13 | 8 regional languages | Todo | Guards are the users least likely to read English |
| G-14 | Device binding to a society | Todo | A stolen handset must not work at another gate |

## 2. Resident app (`apps/mobile-resident`)

Does not exist. More surface than the guard app, much less risk.

| ID | Task | Status | Notes |
|---|---|---|---|
| R-1 | Flutter project, `--flavor resident`, Android + iOS | Todo | |
| R-2 | Phone-OTP login, multi-society switcher | Todo | API already supports it — `person_memberships()` |
| R-3 | **Approve/deny arrival in one tap**, from the push notification | Todo | Must work from the lock screen or the ladder is pointless |
| R-4 | Pre-approve a guest, share pass over WhatsApp | Todo | |
| R-5 | Standing rules per flat and per category | Todo | Server side is built — `ladder.ts` `matchStandingRule()` |
| R-6 | Dues, invoice history, pay online | Todo | Client never computes money; renders what the API returns |
| R-7 | Raise a complaint: photo, video, voice note | Todo | |
| R-8 | SOS with location broadcast | Todo | |
| R-9 | Amenity booking | Todo | Needs F-1 |
| R-10 | Notices, polls, community feed | Todo | Needs C-1 |
| R-11 | 8 regional languages | Todo | |

## 3. Modules on the landing page

The landing page advertises twelve. Each is tagged there with an honest **Available** or
**In build** badge — keep that badge in sync with this table, because it is a public claim.

| # | Module | Server | Console | Mobile | Status |
|---|---|---|---|---|---|
| 1 | Visitor management | Done | Done | — | **Partial** — no handset |
| 2 | Gate & entry approval | Done | Done | — | **Partial** — ladder proven server-side, no app to tap |
| 3 | Employee & staff mgmt | Todo | Todo | Todo | **Todo** → [S-1…S-5](#4-staff-attendance-and-payroll) |
| 4 | Delivery & courier tracking | Todo | Todo | Todo | **Todo** → [D-1…D-4](#7-remaining-modules) |
| 5 | Security guard tools | Partial | — | Todo | Server seams exist; app does not |
| 6 | Emergency SOS & alerts | Todo | Todo | Todo | → [E-1…E-4](#7-remaining-modules) |
| 7 | Amenity booking | Todo | Todo | Todo | → [F-1…F-3](#7-remaining-modules) |
| 8 | Community notices | Todo | Todo | Todo | → [C-1…C-4](#7-remaining-modules) |
| 9 | Maintenance & billing | Done | Done | Todo | Ledger + invoicing proven; payments **Unproven** |
| 10 | Vehicle & parking mgmt | Todo | Todo | Todo | → [V-1…V-4](#7-remaining-modules) |
| 11 | Attendance & payroll | Todo | Todo | Todo | → [S-1…S-5](#4-staff-attendance-and-payroll) |
| 12 | Analytics & reports | Partial | Partial | — | Society summary only → [N-1…N-5](#7-remaining-modules) |

## 4. Staff, attendance and payroll

| ID | Task | Status | Notes |
|---|---|---|---|
| S-1 | `staff`, `attendance` tables + RLS policies | Todo | Named in the data model, no DDL yet |
| S-2 | Staff onboarding with verified profile | Todo | |
| S-3 | Daily check-in/out at the gate | Todo | Reuses the gate event pipeline |
| S-4 | Payroll-ready timesheets, manual override with audit | Todo | Override must be logged — it is a money-adjacent action |
| S-5 | DigiLocker verification, **store result + masked last-4 only** | Todo | Never the Aadhaar number. Aadhaar Act §57 |
| S-6 | Biometric attendance — **opt-in, PIN/card alternative always offered** | Todo | Phase 4. Staff cannot meaningfully refuse an employer, so this is not a plain feature toggle |

> The landing page says "reliable attendance", not "biometric-grade". That wording was
> changed on purpose — see `design/landing/README.md`.

## 5. Payments — proving the money path

Everything here is **written**. None of it has met Razorpay.

| ID | Task | Status | Notes |
|---|---|---|---|
| P-1 | Razorpay test-mode account with **Route + Smart Collect** | Blocked | Needs Krishna |
| P-2 | Pay an invoice end to end; replay the webhook 5× → one receipt | Unproven | Plan §11 test 4 |
| P-3 | Prove settlement targets the *society's* linked account, never ours | Unproven | This is the RBI PA-licence boundary. Must be demonstrated, not assumed |
| P-4 | Smart Collect per-unit virtual accounts → auto-reconcile NEFT/IMPS/UPI | Unproven | |
| P-5 | Mode 2 direct-merchant (owner's own gateway, zero commission) | Unproven | |
| P-6 | Ledger invariant sweep alerting on drift | Done | `internal/ledger/invariants` |
| P-7 | Immutable journal enforced at the DB | Done | Proven by test — `UPDATE` on a posted line is rejected |

## 6. AI service (`apps/ai-service`)

Skeleton only: `config.py`, `api_client.py`, `errors.py`, `secrets.py`, `main.py`.
`modules/` is empty.

| ID | Task | Status | Notes |
|---|---|---|---|
| A-1 | Anthropic API key | Blocked | Needs Krishna |
| A-2 | OCR — bank statements → reconciliation candidates | Todo | Claude. Highest-value AI item |
| A-3 | OCR — meter readings, staff ID documents | Todo | |
| A-4 | **Voice complaint filing in 8 languages** | Todo | Genuinely strong for elderly and low-literacy residents |
| A-5 | Complaint auto-routing + duplicate detection | Todo | Three residents reporting one lift → one ticket, all notified |
| A-6 | Gate device drivers (RFID, ANPR, boom barrier) | Todo | Phase 4 |
| A-7 | Billing-anomaly detection — **aggregate signals only, flags to MC** | Todo | Never profiles a person. Never auto-denies entry |

## 7. Remaining modules

| ID | Task | Status |
|---|---|---|
| D-1 | `deliveries` table, gate-to-doorstep states | Todo |
| D-2 | Proof of handover (photo/signature) | Todo |
| D-3 | Collect-on-behalf when the resident is out | Todo |
| D-4 | Courier partner presets (Swiggy, Zomato, Blue Dart, Amazon) | Todo |
| E-1 | SOS trigger + location broadcast | Todo |
| E-2 | Guard/MC fan-out with acknowledgement tracking | Todo |
| E-3 | Emergency contact directory, **available offline** | Todo |
| E-4 | Full SOS audit trail | Todo |
| F-1 | `amenity_bookings` + conflict prevention (DB-level exclusion constraint) | Todo |
| F-2 | Booking rules: slots, caps, charges, cancellation | Todo |
| F-3 | Amenity booking console + resident UI | Todo |
| C-1 | Notices with targeting (tower/wing/tenant/owner) | Todo |
| C-2 | Multi-channel fan-out — push, SMS, email, WhatsApp | Todo |
| C-3 | **DLT template registry with category enforcement** | Todo |
| C-4 | Polls, events, RSVP, community feed | Todo |
| V-1 | Vehicle registration per unit | Todo |
| V-2 | Parking slot allotment | Todo |
| V-3 | Unauthorised-parking flagging | Todo |
| V-4 | Society-issued UHF RFID barrier integration | Todo (Phase 4) |
| N-1 | Footfall and gate analytics | Todo |
| N-2 | Collections and arrears ageing | Todo |
| N-3 | Incident and SLA-breach dashboards | Todo |
| N-4 | Vendor and staff performance leaderboards | Todo |
| N-5 | Audit-ready report pack (PDF) | Todo |
| N-6 | Tally-compatible export | Todo |
| N-7 | Document repository with role-based access | Todo |

> **C-3 is not a checkbox.** TRAI's TCCCPA ties the DND rules to the *category a template
> was registered under*, so category has to be a property of each template in the
> database, not a flag someone sets at send time.

## 8. Migration tooling (the moat)

Commercially the most important section in this file, and the easiest to under-rate.

| ID | Task | Status | Notes |
|---|---|---|---|
| M-1 | Excel/CSV unit + resident import with per-row results | Partial | `POST /v1/society/units/bulk` exists |
| M-2 | Opening balances import — dues carried across | Todo | The step that actually blocks a switch |
| M-3 | Tally ledger import | Todo | |
| M-4 | Competitor CSV import (MyGate, ADDA, ApnaComplex, NoBrokerHood) | Todo | |
| M-5 | Dry-run mode with a diff before commit | Todo | Nobody commits a 400-flat import blind |
| M-6 | Rollback of a completed import | Todo | |

**Target: a 400-flat society switches in under 48 hours, under 2 hours of our time.** If
support runs past ~20 minutes per society per month, the business model breaks before 400
societies.

## 9. Compliance (DPDP — hard deadline 13 May 2027)

| ID | Task | Status |
|---|---|---|
| L-1 | Append-only consent ledger, versioned notice text | Partial — table exists, no manager |
| L-2 | Consent withdrawal + downstream propagation | Todo |
| L-3 | Per-person data export (JSON + PDF) | Todo |
| L-4 | Erasure with cascade; financial records retained under statutory exemption | Todo |
| L-5 | Breach-notification runbook → Data Protection Board | Todo |
| L-6 | Named DPO published in-app | Todo |
| L-7 | DPAs with Razorpay, MSG91, Cloudflare, Google, Anthropic, Meta | Todo |
| L-8 | CCTV 30-day retention cap, every access logged with a reason | Todo |
| L-9 | Immutable audit log across financial + access actions | **Done** |
| L-10 | Tenant isolation proven against live Postgres | **Done** — 51 tests, includes a negative control |

## 10. Platform and release

| ID | Task | Status | Notes |
|---|---|---|---|
| X-1 | Desktop app has **never been compiled** | Todo | Needs the Rust toolchain; `npm run desktop:build` unrun |
| X-2 | Terraform for Cloud Run, Tasks, Scheduler, Secret Manager | Todo | Plan says day 1; not started |
| X-3 | CI: tests + isolation suite gating merge | Todo | The isolation test failing must fail the build |
| X-4 | Sentry + OpenTelemetry | Todo | |
| X-5 | k6 load test — 2M events/day, 10× burst, p95 ack < 800 ms | Todo | |
| X-6 | Third-party penetration test | Todo | Before the 26th society |
| X-7 | Quarterly restore drill (RPO 5 min / RTO 1 hr) | Todo | Also exercises the Neon→Postgres exit path |
| X-8 | `FEATURES.md` / `AUDIT_TRAIL.md` brought current | Todo | Both stale |

## 11. Blocked on credentials

None of these block *building* — every one is stubbed and the whole stack runs locally
with no cloud account. They block **going live**.

| Credential | Needed for | Blocks |
|---|---|---|
| Razorpay (Route + Smart Collect) | Collections, settlement | P-1…P-5 |
| MSG91 + **DLT-registered templates** | OTP, reminders, notices | C-2, C-3 |
| Cloudflare R2 | Photos, documents | G-7, R-7 |
| FCM (+ APNs) | Every push notification | R-3 — the approval ladder's first rung |
| GCP project | Cloud Run, Tasks, Scheduler, Secret Manager | X-2 |
| Exotel | The ladder's 20-second IVR call | Ladder rung 2 |
| Anthropic API key | OCR, voice complaints | A-1…A-5 |
| WhatsApp Business (Meta) | Notices, reminders | C-2 |
| Play Store + Apple Developer | Shipping the apps | G-1, R-1 |

---

## Notes on how to read this file

**Unproven is not Done.** The Razorpay integration is complete code that has never taken a
signed webhook from Razorpay. Marking it Done would hide the single most expensive class of
bug in the product.

**The landing page makes public claims.** Twelve modules are advertised with Available /
In build badges. When a module's status changes here, change it there — a stale badge on a
public page is a false claim, not a documentation lapse.

**Nothing is removed from this backlog without an explicit instruction from Krishna.**
Items cut from the original brief are recorded with reasons in `design/ARCHITECTURE.md` §1,
not silently dropped.
