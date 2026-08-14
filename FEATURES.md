# WatchMyGate — Features

Single source of truth for scope. **No feature is removed from this file without an explicit
instruction from Krishna.** Items deliberately not built are listed in "Cut / deferred" with
reasons, not silently deleted.

Last updated 13 Aug 2026. Design detail lives in [design/](design/).

Legend: `planned` · `in-progress` · `completed`

---

## Phase 0 — Foundation

| Feature | Status |
|---|---|
| Monorepo, isolated Python venv (uv), docker-compose local stack | completed |
| Alembic migrations + core schema | completed |
| Postgres Row-Level Security + `NOBYPASSRLS` app role | completed |
| `tenant_context` wrapper + lint ban on raw pool queries | completed |
| **Cross-tenant leak test as a build gate** (21 tests) | completed |
| Phone OTP auth, JWT + rotating refresh with reuse detection | completed |
| Device binding fields on guard sessions | completed |
| Money primitives — Decimal, half-up rounding, exact allocation | completed |
| Immutable audit log (append-only grants, monthly partitions) | completed |
| Seed data — two societies, one person in both | completed |
| CI/CD with gated migrations + isolation as a separate gate | completed |
| Terraform skeleton (Cloud Run, Cloud Tasks, Scheduler, Secret Manager) | completed |
| Society/tenant bootstrap API (create society, towers, units) | planned |
| TOTP 2FA enrolment for privileged roles | planned |

## Phase 1 — Gate track

| Feature | Status |
|---|---|
| Pre-approved visitor entry — QR / OTP / passcode | planned |
| Offline-verifiable signed passes (Ed25519) | planned |
| Ad-hoc visitor approval with photo capture | planned |
| Approval ladder: push → IVR → standing rule → MC escalation | planned |
| Cab / delivery / courier flows | planned |
| Digital entry/exit logs + overstay alerts | planned |
| Guard app offline mode with outbox sync | planned |
| SOS panic button — medical, fire, gas, security | planned |
| Emergency contact directory (available offline) | planned |

## Phase 1 — Money track

| Feature | Status |
|---|---|
| Units, towers, bitemporal occupancy model | planned |
| Invoice generation — flat / per-sq-ft / per-BHK / per-meter / sinking fund | planned |
| Late fees, interest, GST rule engine | planned |
| Double-entry immutable ledger | planned |
| Payments Mode 1 — Razorpay Route + Smart Collect | planned |
| Payments Mode 2 — direct merchant ID, zero platform commission | planned |
| Auto-reconciliation of NEFT/IMPS/UPI credits | planned |
| Dues / defaulter tracking + multi-channel reminders | planned |
| Digital receipts, GST-compliant invoicing | planned |

## Phase 1 — Helpdesk track

| Feature | Status |
|---|---|
| Complaint raising with photo / video / voice attachments | planned |
| Category auto-routing to vendor or staff | planned |
| SLA timers + auto-escalation matrix | planned |
| Threaded updates, staff-only internal notes | planned |
| Proof-of-fix photo required to resolve | planned |
| Resident rating + 7-day reopen | planned |
| Duplicate detection and ticket merge | planned |

## Phase 2 — Operating surface

| Feature | Status |
|---|---|
| Notices via push / SMS / email / WhatsApp | planned |
| Tower / wing / tenant-targeted notifications | planned |
| Discussion forums, polls, community feed | planned |
| Neighbour directory with privacy controls, opt-in chat | planned |
| Lost & found, event calendar, RSVP | planned |
| Amenity booking with DB-level double-booking prevention | planned |
| Document repository with role-based access | planned |
| Parking slot allocation | planned |
| Society admin console | planned |
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
| **Migration tooling — Tally / Excel / competitor CSV import** | planned |
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
| Voice complaint filing (8 languages) | planned |
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
