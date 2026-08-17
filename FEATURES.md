# WatchMyGate — Features

Single source of truth for scope. **No feature is removed from this file without an explicit
instruction from Krishna.** Items deliberately not built are listed in "Cut / deferred" with
reasons, not silently deleted.

Last updated 15 Aug 2026 (second pass). Design detail lives in [design/](design/), remaining work in
[BACKLOG.md](BACKLOG.md).

**`completed` means built *and* covered by a test that would fail if it broke.** Code that
exists but has never run against the real dependency is `unproven`, which is a different
thing and is marked as such — the payments path is the case that matters.

Legend: `planned` · `in-progress` · `unproven` · `completed`

---

## Phase 0 — Foundation

| Feature | Status |
|---|---|
| Monorepo, npm workspaces, no local Docker (real Neon only) | completed |
| Versioned SQL migrations (0001–0008) + Drizzle schema | completed |
| Postgres Row-Level Security + `NOBYPASSRLS` app role | completed |
| `withTenant` wrapper — every query inside an explicit transaction | completed |
| **Cross-tenant leak test** (54 tests, incl. a negative control) | completed |
| Phone OTP auth, JWT + rotating refresh with reuse detection | completed |
| Device binding fields on guard sessions | completed |
| Money primitives — Decimal, half-up rounding, exact allocation | completed |
| Immutable audit log (append-only grants, monthly partitions) | completed |
| Seed data — two societies, one person in both | completed |
| CI/CD with gated migrations + isolation as a separate gate | completed | isolation runs on a real Postgres as the app role |
| Terraform (Cloud Run, Cloud Tasks, Scheduler, Secret Manager) | planned |
| Society/tenant bootstrap API (create society, towers, units) | completed |
| TOTP 2FA enrolment for privileged roles | planned |

## Phase 1 — Gate track

| Feature | Status |
|---|---|
| Pre-approved visitor entry — QR / OTP / passcode | completed |
| Offline-verifiable signed passes (Ed25519) | completed | server side; Dart verifier still to build |
| Ad-hoc visitor approval with photo capture | completed |
| Approval ladder: push → IVR → standing rule → MC escalation | completed | elapsed-time driven, survives restart |
| Cab / delivery / courier flows | completed |
| Digital entry/exit logs + overstay alerts | completed |
| Guard app offline mode with outbox sync | completed | airplane-mode acceptance test passes against live Neon |
| SOS panic button — medical, fire, gas, security | completed | raise from the app, handle on the console |
| Emergency contact directory (available offline) | planned |

## Phase 1 — Money track

| Feature | Status |
|---|---|
| Units, towers, bitemporal occupancy model | completed |
| Invoice generation — flat / per-sq-ft / per-BHK / per-meter / sinking fund | completed |
| Late fees, interest, GST rule engine | completed |
| Double-entry immutable ledger | completed | immutability enforced by the database |
| Payments Mode 1 — Razorpay Route + Smart Collect | unproven | written, never met Razorpay |
| Payments Mode 2 — direct merchant ID, zero platform commission | unproven | written, never met Razorpay |
| Auto-reconciliation of NEFT/IMPS/UPI credits | unproven | needs Smart Collect credentials |
| Dues / defaulter tracking + multi-channel reminders | in-progress | tracking done; reminder channels stubbed |
| Digital receipts, GST-compliant invoicing | completed |

## Phase 1 — Helpdesk track

| Feature | Status |
|---|---|
| Complaint raising with photo / video / voice attachments | completed |
| Category auto-routing to vendor or staff | completed |
| SLA timers + auto-escalation matrix | completed |
| Threaded updates, staff-only internal notes | completed |
| Proof-of-fix photo required to resolve | completed |
| Resident rating + 7-day reopen | completed |
| Duplicate detection and ticket merge | completed |

## Phase 2 — Operating surface

| Feature | Status |
|---|---|
| Notices via push / SMS / email / WhatsApp | in-progress | notices + DLT category rule done; senders stubbed |
| Tower / wing / tenant-targeted notifications | completed | audience resolved server-side |
| Discussion forums, polls, community feed | in-progress | polls, votes, read receipts, feed done; forums planned |
| Neighbour directory with privacy controls, opt-in chat | planned |
| Lost & found, event calendar, RSVP | planned |
| Amenity booking with DB-level double-booking prevention | completed | endpoints added; overlap refused by the constraint |
| Document repository with role-based access | planned |
| Parking slot allocation | completed | plus vehicles and violation flagging |
| Society admin console | completed | 9 pages incl. staff, operations and notices |
| Chart of accounts, trial balance, P&L, balance sheet | planned |
| Tally-compatible export, PDF vouchers | planned |
| Role-based accounting access (Admin / Assistant / DEO / Auditor) | planned |
| Bulk bill clearing via bank statement or Excel upload | planned |
| Helpdesk analytics — ageing, SLA breaches, vendor leaderboard | planned |
| Ticket search and filter by flat, category, keyword, status | planned |
| Visitor blacklist / watchlist | planned |

## Phase 3 — Pilot hardening

| Feature | Status |
|---|---|
| **Migration tooling — Tally / Excel / competitor CSV import** | in-progress | flats + opening balances done; Tally/competitor formats next |
| Guard training kit and onboarding playbook | planned |
| 8 regional languages, resident + guard apps | planned |
| DPDP consent manager and consent ledger | planned |
| Data export and erasure with cascade | planned |
| Budget planning and variance tracking | planned |
| Corpus / sinking fund with restricted-use controls | planned |
| State rule-packs (MCS Act, KAOA, RERA AOA) | planned |
| TDS 194C/194J and Form 26Q data | planned |
| Audit-ready report pack | planned |
| Move-in / move-out workflow + digital NOC | planned |
| Asset register and maintenance schedule | planned |
| Water tanker / utility monitoring | planned |
| Staff attendance, payroll computation, verification workflow | planned |
| Staff ratings, vendor directory and performance tracking | planned |
| Voice complaint filing (8 languages) | completed | resident confirms before filing |
| OCR — bank statements, meter readings, staff IDs | planned |
| Configurable approval workflows (two-signature thresholds) | planned |
| SLOs, alerting, penetration test | planned |

## Phase 4 — Expansion

| Feature | Status |
|---|---|
| Home services marketplace, local business directory | planned |
| Unified wallet | planned |
| Vehicle management — society-issued UHF RFID barriers | planned |
| ANPR number-plate recognition | planned |
| CCTV / NVR integration hooks | planned |
| Biometric / facial entry (opt-in, PIN alternative mandatory) | planned |
| Cross-society blacklist network | planned |
| Committee election and term management | planned |
| Digital AGM and e-voting with audit trail | planned |
| Super Admin multi-society portfolio dashboard | planned |
| White-label per builder | planned |
| Smart notice prioritisation | planned |
| Billing anomaly detection (non-personal signals only) | planned |
| Sustainability dashboard | planned |
| Open APIs / webhooks for IoT, EV charging, smart meters | planned |
| Guard performance analytics, geofenced patrol check-ins | planned |
| School bus / shuttle tracking | planned |

---

## Cut / deferred — with reasons

| Item | Decision | Reason |
|---|---|---|
| "Vehicle Sentry" remote vehicle immobilisation | **Cut** | Remotely immobilising a vehicle can kill people. Uninsurable product liability, no legal basis. Replaced with alert-only to the owner. |
| FASTag-based boom barriers | **Cut as specified** | NETC FASTag for parking requires an IHMCL-authorised acquirer bank. Society-issued UHF RFID does the same job, cheaper and unregulated. |
| Dark-web / fraud monitoring of society accounts | **Cut** | No credible signal. Implies a security guarantee we cannot honour. |
| Emergency drone dispatch | **Cut** | DGCA-regulated airspace. Not a product. |
| Predictive maintenance (lifts, pumps, gensets) | **Deferred past Phase 4** | Needs 2+ years of telemetry that will not exist. Scheduled-maintenance reminders ship instead, named honestly. |
| Aadhaar-based staff verification | **Redesigned** | Aadhaar Act §57 struck down — cannot be mandated by private entities. DigiLocker / offline XML; store result + masked last-4 only, never the number. |
| Notices to DND-registered numbers | **Redesigned** | TRAI TCCCPA — only transactional and service-explicit categories may reach DND numbers. Category is part of the template definition. |
| AI anomaly detection on visitor patterns | **Scoped hard** | Profiling delivery workers and domestic staff is a DPDP significant-harm exposure. Aggregate, non-personal signals only; never auto-denies a person. |
