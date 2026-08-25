# WatchMyGate — Backlog

Everything left to build, in the order it should be built. Status here is deliberately
conservative: **Done** means it exists *and* is proven by a test that would fail if it
broke. Code that exists but has never been exercised against the real dependency is
**Unproven**, not Done — that distinction is the whole point of this file.

Counts as of the last update: **460 TypeScript tests** (db 267, money 66, api 114,
worker 13), **81 Dart tests** (guard 61, resident 20), **30 Python tests**, **45
end-to-end checks**, **35 Phase 2 smoke checks** and **237 console smoke checks** — all
green against live Neon.

Legend — **Done** · **Unproven** (built, never exercised for real) · **Partial** ·
**Todo** · **Blocked** (needs a credential from Krishna)

---

## 0. The critical path

If nothing else gets done, this is the order. Each line is the highest-value thing
available once the line above it is finished.

| # | Item | Why it is next | Backlog ref |
|---|---|---|---|
| 1 | **Financial reports — trial balance, P&L, balance sheet** | The single highest value per hour left. Every committee's auditor asks for these, the double-entry ledger already holds the data, and only the endpoints and pages are missing. It is also the largest gap against MyGate Elite. | [MG-1](#7c-competitive-gaps-against-mygate) |
| 2 | **Razorpay test-mode proof** | The money path is written but has never taken a real signed webhook — the cheapest possible discovery of the most expensive class of bug here. **Blocked on your keys.** | [P-1 … P-5](#5-payments-proving-the-money-path) |
| 3 | **Run both apps on a real handset** | Both build and every piece of logic is tested, but neither has run on physical hardware. The camera and Keystore paths are unverified. | — |
| 4 | **Tally export**, then Tally + competitor import | Import brings a society in; export is what lets their accountant keep working. Refusing to build it is a lock-in tactic that loses deals. | [MG-2](#7c-competitive-gaps-against-mygate), [M-3, M-4](#8-migration-tooling-the-moat) |
| 5 | **Document repository** | Bye-laws, AGM minutes, audited accounts. Trivial on the attachment machinery that already exists, and it closes a Basic-plan gap. | [MG-30](#7c-competitive-gaps-against-mygate) |
| 6 | **Guard patrolling + kids checkout** | The two gate features a security agency and a parent respectively ask about first. | [MG-20, MG-21](#7c-competitive-gaps-against-mygate) |
| 7 | **Remaining guard/resident app features** | Camera capture, incidents, device binding; complaints and amenities in the resident app. | [G-7, G-11](#1-guard-app-appsmobile-guard) |
| 8 | **Terraform + deploy** | Nothing is deployed anywhere. CI runs; there is no environment for it to ship to. | [X-2](#10-platform-and-release) |

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
| 7 | Amenity booking | **Done** | **Done** | Todo | Double-booking refused by the database, verified from the console |
| 8 | Community notices | **Done** | **Done** | Todo | Console shows which notices may be texted, and why |
| 9 | Maintenance & billing | Done | Done | **Partial** | Dues visible in the app; payments still **Unproven** |
| 10 | Vehicle & parking mgmt | **Done** | **Done** | Todo | On the Gate Operations page |
| 11 | Attendance & payroll | **Done** | **Done** | Todo | Timesheet shows which days a human edited |
| 12 | Analytics & reports | **Done** | **Done** | — | Reports page: footfall, arrears ageing, defaulters, SLA, staff |

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
| E-1 | SOS trigger + location broadcast | **Done** — insert-only, no role check on raising |
| E-2 | Guard/MC fan-out with acknowledgement tracking | **Done** — first responder wins; console shows an alarm band |
| E-3 | Emergency contact directory, **available offline** | Todo |
| E-4 | Full SOS audit trail | **Done** — raise, acknowledge and close all recorded with who |
| F-1 | `amenity_bookings` + conflict prevention (DB-level exclusion constraint) | **Done** — overlap refused by Postgres, proven by a colliding request |
| F-2 | Booking rules: slots, caps, charges, cancellation | **Done** — cancel sets a status, never deletes the row |
| F-3 | Amenity booking console + resident UI | **Partial** — console done; resident app still read-only here |
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

## 7b. Admin console (`apps/web-admin`)

Until now this section did not exist, and the omission hid something: the console was a
**read-only viewer over a complete API**. Fourteen screens, 107 endpoints behind them, and
the only write in the entire application was the login form. A committee could watch their
society through it but could not operate it — every action still needed an HTTP client.

That is closed. Every page now writes, and each write is exercised by
`npm run e2e:console` sending the exact request bodies the pages send.

| ID | Task | Status | Notes |
|---|---|---|---|
| W-1 | Console wears the landing page's theme | **Done** | Warm paper, maroon and gold, Bricolage/Manrope. Money keeps tabular figures; red stays reserved for arrears |
| W-2 | Roles carried in the session | **Done** | Actions that would 403 are not offered. Not a boundary — the API rechecks everything |
| W-3 | Complaints: raise, thread, comment, internal note, status, reopen | **Done** | Resolve is blocked until a proof-of-fix photo exists |
| W-4 | Billing: preview → issue, with meter readings | **Done** | Preview is mandatory; changing any input voids it |
| W-5 | Payments: destinations, manual receipts | **Done** | Re-entering the same cheque records one receipt |
| W-6 | Gate: issue passes, decide pending approvals, ladder history | **Done** | Pending list polls at 10s, inside the ladder's 20s first rung |
| W-7 | Operations: SOS acknowledge/close, parcel log and handover | **Done** | Alarm band is the only loud thing in the console |
| W-8 | Parking: vehicles, slots, allotment, violations | **Done** | Plate search normalises like the gate lookup does |
| W-9 | Staff: add, status, PIN, verification, check in/out, timesheet | **Done** | PIN always offered as the non-biometric route |
| W-10 | Notices: compose, publish, polls, read receipts | **Done** | Draft and publish are separate steps |
| W-11 | Flats: towers, single and bulk add, move in, move out | **Done** | `101-108` expands; move-out end-dates rather than deletes |
| W-12 | Directory: grant and revoke roles | **Done** | Warns when more than three people hold society admin |
| W-13 | Amenities: create, book, cancel | **Done** | Overlap refused by the database, shown as such |
| W-14 | Reports: footfall, ageing arrears, defaulters, SLA, staff | **Done** | Arrears bucketed by age; money-denied degrades to the rest of the page |
| W-15 | Import: paste a sheet, preview, commit | **Done** | Column names auto-matched; preview writes nothing |
| W-16 | `GET /v1/billing/charge-types` | **Done** | Added — the console could not otherwise know a head needs a meter reading |
| W-17 | `BillingError` mapped to 422 | **Done** | Was a 500 saying "Something went wrong" for every billing refusal |
| W-18 | Attachment upload from the console | Todo | Presign + PUT exists for the phone; the console can only view |
| W-19 | Ledger reporting — trial balance, P&L, chart of accounts | Todo | No endpoints yet either, only the internal invariant checker |
| W-20 | Document repository | Todo | No API, no page |
| W-21 | Super-admin portfolio console | Todo | Phase 4 |

## 7c. Competitive gaps against MyGate

Everything in this section comes from the February 2026 MyGate sales deck (120 pp), the
SaaS brochure and notes from a real sales conversation — all analysed in
[`design/COMPETITOR_MYGATE.md`](design/COMPETITOR_MYGATE.md) and packaged into two plans in
[`design/PLANS.md`](design/PLANS.md).

Ordered by what would lose us a deal, not by size. `Plan` says which of Basic/Pro the
feature is sold in.

### The money gaps — all Pro

The ledger already holds this data. These are almost entirely missing *endpoints and
pages*, not missing foundations, which is why they rank first.

| ID | Task | Plan | Status | Notes |
|---|---|---|---|---|
| MG-1 | Trial balance, Income & Expenditure, balance sheet | Pro | **Done** | Proven arithmetically against live Neon, not asserted |
| MG-2 | **Tally-compatible export** | Pro | **Done** | Import brings a society in; export is what lets their accountant keep working. Withholding it is a lock-in tactic that also loses deals |
| MG-3 | House statement across financial years | Pro | **Done** | |
| MG-4 | Cash and fund flow report | Pro | **Done** | |
| MG-5 | Invoice and receipt PDFs | Pro | **Done** | Hand-written PDF writer, no dependency, ~3 KB a document; amount in words; a resident gets their own flat's and nobody else's |
| MG-6 | Budget vs actual by head | Pro | **Done** | Approved budgets frozen by trigger; the drafter cannot pass it; unbudgeted spend is on the report |
| MG-7 | Asset and inventory register | Pro | **Done** | Plus a maintenance schedule that recurs, AMC countdown, and a fixed-asset schedule labelled with the method it used |
| MG-8 | PR/PO with multi-level approval chain | Pro | Todo | Where MyGate's ERP differentiation actually lives |
| MG-9 | Vendor bills and payment history | Pro | Todo | |
| MG-10 | Security deposits — collect, hold, reverse | Pro | Todo | MyGate ties this to amenity bookings |
| MG-11 | Advance and credit balances per flat | Pro | **Done** | Modelled, reported, and swept onto the next invoice inside the same transaction |
| MG-12 | Penalty report + invoice-footer penalty summary | Pro | **Done** | The footer prints the charge next to the rule; the report separates charged from collected |
| MG-13 | Period lock / audit lock by financial year | Pro | **Done** | Reopening needs a second person and a stated reason |
| MG-14 | GST returns, e-invoicing, TDS 194C/194J, Form 26Q | Pro | Todo | |
| MG-15 | Slab-based penalty configuration | Pro | Partial | We have one percentage per month, not slabs |
| MG-16 | Bulk payout report — one bank entry per day | Pro | Todo | Depends on Razorpay settlement reporting |
| MG-17 | Side-by-side invoice preview across flats before publishing | Pro | Partial | We preview one flat; theirs compares a whole run |
| MG-18 | Utility / prepaid-meter vendor integration | Pro | Todo | They integrate 14 vendors |
| MG-19 | Wire OCR statement candidates into reconciliation | Pro | Todo | The AI service returns candidates; nothing consumes them |

### The gate gaps — Basic

| ID | Task | Plan | Status | Notes |
|---|---|---|---|---|
| MG-20 | **Guard patrolling** with geofenced check-ins | Basic | Todo | The first thing a security agency asks about |
| MG-21 | **Kids checkout** — child leaves, guardian approves | Basic | Todo | Small, emotionally central to parents, clean in a demo |
| MG-22 | Digital register replacing the gate book, Excel export | Basic | Todo | Named specifically for trucks in the sales notes |
| MG-23 | **Animated QR / screenshot protection** | Basic | **Done** | v2 rolling proof, 30 s step, +/-1 tolerance. A forwarded screenshot stops working. The resident app does not yet generate its keypair |
| MG-24 | Frequent-visitor list and one-click re-invite | Basic | Partial | Passes exist; "invite my regulars again" does not |
| MG-25 | Visitor photo in the approval notification | Basic | Partial | Capture is designed; not wired to push |
| MG-26 | Offline emergency contact directory | Basic | Todo | Must work with no network, like the passes |
| MG-27 | e-Intercom — resident↔resident, resident↔guard, guard↔resident | Basic | Todo | The daily interaction. Needs a voice provider |
| MG-28 | Guest parking allotment | Basic | Partial | Slot kind exists; no guest flow |
| MG-29 | Entry/exit retention policy — purge after 6 months | Basic | **Done** | Retention policy table plus a purge that actually runs |

### The community gaps — Basic

| ID | Task | Plan | Status | Notes |
|---|---|---|---|---|
| MG-30 | **Document repository** — bye-laws, minutes, audited accounts | Basic | **Done** | Visibility is the design: society / committee / one flat, filtered in SQL |
| MG-31 | Move-in / move-out workflow with approvals and document collection | Basic | Partial | Occupancy in/out done; the workflow, dues clearance and NOC are not |
| MG-32 | Rental agreement storage with expiry status | Basic | **Done** | A category on the repository, not a second system |
| MG-33 | Surveys — several questions, not one | Basic | Partial | Polls hold a single question |
| MG-34 | Elections — candidates, turnout report, result/turnout split | Basic | Partial | Voting works; the election apparatus does not |
| MG-35 | AGM scheduling, agenda, minutes, quorum | Basic | Todo | |
| MG-36 | Neighbour directory with privacy controls | Basic | Todo | Distinct from the roles directory that exists |
| MG-37 | Helpdesk auto-assignment by category and skill | Basic | Partial | We route by category only |
| MG-38 | Round-robin assignment by who is actually on site | Basic | Todo | Clever: uses gate attendance to pick an assignee |
| MG-39 | OTP-based complaint resolution by the technician | Basic | Todo | Resident's OTP closes the ticket. Do this *and* keep proof-of-fix |
| MG-40 | Comment templates for helpdesk staff | Basic | Todo | |
| MG-41 | Staff-facing app for technicians | Basic | Todo | MyGate's "Saarthi". A fourth binary — weigh carefully |
| MG-42 | MIS/TAT reports by assignee, with export | Basic | Partial | Reports page has ageing and breaches, not by assignee |
| MG-43 | Amenity depth — access control, grouping, cooldown, cancellation charges, recurring bookings, utilisation report | Basic | Todo | Their soft-block is an app-level fix for the race our constraint already prevents |
| MG-44 | Custom roles | Basic | Todo | We ship seven fixed; they allow ten custom |
| MG-45 | Audit log viewer in the console | Basic | Partial | The log is immutable and complete; nothing displays it |
| MG-46 | Rent-a-parking between residents | Basic | Todo | We store a monthly rate; there is no rental flow |
| MG-47 | Community feed, classes, pet directory, buy & sell, local services | Basic | Todo | Phase 4. Pet vaccination status is a good hook |

### Deliberately refused

Not omissions. Each is a decision, recorded so a later pass does not "fix" it.

| ID | MyGate feature | Decision |
|---|---|---|
| MG-48 | Blocking visitor approvals, gate passes, move-in/out and **complaint logging** until arrears are cleared | **Refuse the parts that touch safety, home access or fault reporting.** Withholding discretionary benefits — the party hall, a guest slot — is fine. Using the gate as a debt-collection lever against a household is not |
| MG-49 | Advertising engine, lift posters, standees, gate signage, door tags, sampling kiosks | **Refuse.** The landing page commits to no ads and no data sale. Their brochure sells all of this two pages after "Your data doesn't interest us" |
| MG-50 | Platform fee charged to the resident per payment (₹5.9 / ₹11 in their notes) | **Refuse.** ~₹22,500 a year taken from residents of a 171-unit society, on top of the licence, and it appears on no slide |

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
