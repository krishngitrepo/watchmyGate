# WatchMyGate — Backlog

Everything left to build, in the order it should be built. Status here is deliberately
conservative: **Done** means it exists *and* is proven by a test that would fail if it
broke. Code that exists but has never been exercised against the real dependency is
**Unproven**, not Done — that distinction is the whole point of this file.

Counts as of the last update: **377 TypeScript tests** (db 223, money 55, api 86,
worker 13), **77 Dart tests** (guard 57, resident 20), **30 Python tests**, **45
end-to-end checks** and **35 Phase 2 smoke checks** — all green against live Neon.

Legend — **Done** · **Unproven** (built, never exercised for real) · **Partial** ·
**Todo** · **Blocked** (needs a credential from Krishna)

---

## 0. The critical path

If nothing else gets done, this is the order. Each line is the highest-value thing
available once the line above it is finished.

| # | Item | Why it is next | Backlog ref |
|---|---|---|---|
| 5 | **Remaining guard/resident features** | Camera capture, patrols, incidents, device binding; complaints and amenities in the resident app. | [G-7, G-11](#1-guard-app-appsmobile-guard) |
| 1 | **Razorpay test-mode proof** | Now the top item. The money path is written but has never taken a real signed webhook — the cheapest possible discovery of the most expensive class of bug here. **Blocked on your keys.** | [P-1 … P-5](#5-payments-proving-the-money-path) |
| 2 | **Run both apps on a real handset** | Both build and every piece of logic is tested, but neither has run on physical hardware. The camera and Keystore paths are unverified. | — |
| 3 | **Tally + competitor CSV import** | Flats and opening balances are done. Tally and competitor formats are what remain. | [M-3, M-4](#8-migration-tooling-the-moat) |
| 4 | **Terraform + deploy** | Nothing is deployed anywhere. CI runs; there is no environment for it to ship to. | [X-2](#10-platform-and-release) |

---

## 1. Guard app (`apps/mobile-guard`)

Does not exist. This is the largest gap in the product.

The security posture differs from the resident app on purpose: guard handsets are
society-owned, shared between shifts, and frequently cheap Android hardware. They must not
retain resident PII past a shift.

| ID | Task | Status | Notes |
|---|---|---|---|
| G-1 | Flutter project, Android-first | **Done** | Debug APK builds; minSdk 23 (Keystore floor) |
| G-2 | SQLite under SQLCipher, key in Android Keystore | **Done** | `resetOnError: false` so a lost key fails loudly |
| G-3 | Append-only outbox with client-generated UUIDv7 keys | **Done** | Trigger blocks DELETE; tested |
| G-4 | Ordered sync drain with exponential backoff | **Done** | Rejected rows park; auth failure parks nothing |
| G-5 | **Ed25519 pass verifier in Dart** | **Done** | Verified against TypeScript-signed vectors |
| G-6 | Cached society public keys, several versions | **Done** | Survive the shift purge deliberately |
| G-7 | Entry capture: photo, purpose, category, vehicle | **Partial** | Category and pass captured; no camera photo yet |
| G-8 | Shift handover + PII purge on shift end | **Done** | Purges cache, keeps outbox and signing keys |
| G-9 | **Airplane-mode acceptance test** | **Done** | Passes against live Neon; 3 replays → 3 rows |
| G-10 | Dart golden-vector runner for money formatting | Todo | Pass vectors done; money vectors still to wire up |
| G-11 | Guard tools: patrol check-ins, incident log | Todo | Shift log done; patrols and incidents not |
| G-12 | SOS receive + acknowledge | Todo | Pairs with R-8 |
| G-13 | 8 regional languages | **Done** | Coverage + no-untranslated-copy tests |
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
| 1 | Visitor management | Done | Done | **Done** | Guard scans offline; resident approves and pre-approves |
| 2 | Gate & entry approval | Done | Done | **Done** | Both halves of the ladder exist now |
| 3 | Employee & staff mgmt | **Done** | **Done** | Todo | Console page live; no handset flow |
| 4 | Delivery & courier tracking | **Done** | **Done** | Todo | On the Gate Operations page |
| 5 | Security guard tools | Partial | — | **Partial** | Offline verify + sync proven; patrols/incidents pending |
| 6 | Emergency SOS & alerts | **Done** | **Done** | **Done** | Raise from the resident app, handle on the console |
| 7 | Amenity booking | **Done** | Todo | Todo | Double-booking refused by the database, verified |
| 8 | Community notices | **Done** | **Done** | Todo | Console shows which notices may be texted, and why |
| 9 | Maintenance & billing | Done | Done | **Partial** | Dues visible in the app; payments still **Unproven** |
| 10 | Vehicle & parking mgmt | **Done** | **Done** | Todo | On the Gate Operations page |
| 11 | Attendance & payroll | **Done** | **Done** | Todo | Timesheet shows which days a human edited |
| 12 | Analytics & reports | **Done** | Partial | — | Footfall, arrears ageing, defaulters, SLA, staff |

## 4. Staff, attendance and payroll

| ID | Task | Status | Notes |
|---|---|---|---|
| S-1 | `staff`, `attendance` tables + RLS policies | **Done** | Migrations 0007/0008, in the isolation suite |
| S-2 | Staff onboarding with verified profile | **Done** | `POST /v1/staff`, multi-flat assignments |
| S-3 | Daily check-in/out at the gate | **Done** | PIN/card/scan; server clock; idempotent per day |
| S-4 | Payroll-ready timesheets, manual override with audit | **Done** | Overrides carry who and why; rows cannot be deleted |
| S-5 | DigiLocker verification, **store result + masked last-4 only** | **Partial** | Storage + API done and enforced; no DigiLocker call yet |
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
| A-2 | OCR — bank statements → reconciliation candidates | **Done** | Returns candidates only; cannot post |
| A-3 | OCR — meter readings, staff ID documents | Todo | |
| A-4 | **Voice complaint filing in 8 languages** | **Done** | Always requires resident confirmation |
| A-5 | Complaint auto-routing + duplicate detection | Todo | Three residents reporting one lift → one ticket, all notified |
| A-6 | Gate device drivers (RFID, ANPR, boom barrier) | Todo | Phase 4 |
| A-7 | Billing-anomaly detection — **aggregate signals only, flags to MC** | Todo | Never profiles a person. Never auto-denies entry |

## 7. Remaining modules

| ID | Task | Status |
|---|---|---|
| D-1 | `deliveries` table, gate-to-doorstep states | **Done** |
| D-2 | Proof of handover (photo/signature) | **Done** — recipient name required |
| D-3 | Collect-on-behalf when the resident is out | **Done** — `held_at_gate` → `collected` |
| D-4 | Courier partner presets (Swiggy, Zomato, Blue Dart, Amazon) | Todo |
| E-1 | SOS trigger + location broadcast | Todo |
| E-2 | Guard/MC fan-out with acknowledgement tracking | Todo |
| E-3 | Emergency contact directory, **available offline** | Todo |
| E-4 | Full SOS audit trail | Todo |
| F-1 | `amenity_bookings` + conflict prevention (DB-level exclusion constraint) | Todo |
| F-2 | Booking rules: slots, caps, charges, cancellation | Todo |
| F-3 | Amenity booking console + resident UI | Todo |
| C-1 | Notices with targeting (tower/wing/tenant/owner) | **Done** — audience resolved server-side |
| C-2 | Multi-channel fan-out — push, SMS, email, WhatsApp | **Partial** — channels decided; senders still stubbed |
| C-3 | **DLT template registry with category enforcement** | **Done** — table + `channelsFor` refuses promotional SMS |
| C-4 | Polls, events, RSVP, community feed | **Done** — polls, votes, read receipts, feed |
| V-1 | Vehicle registration per unit | **Done** |
| V-2 | Parking slot allotment | **Done** — one slot per vehicle enforced |
| V-3 | Unauthorised-parking flagging | **Done** — works for unregistered plates |
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
| M-1 | Excel/CSV unit + resident import with per-row results | **Done** | Re-running is safe — proven by importing twice |
| M-2 | Opening balances import — dues carried across | **Done** | Written as ordinary invoices; verified exact to the paisa |
| M-3 | Tally ledger import | Todo | |
| M-4 | Competitor CSV import (MyGate, ADDA, ApnaComplex, NoBrokerHood) | Todo | |
| M-5 | Dry-run mode with a diff before commit | **Done** | Dry run is the *default*; committing is explicit |
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
| X-3 | CI: tests + isolation suite gating merge | **Done** | Real Postgres, app role, plus a committed-secrets check |
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
