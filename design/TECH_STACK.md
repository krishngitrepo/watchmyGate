# WatchMyGate — Tech Stack

Status: **decided**. Last updated 13 Aug 2026.

Three languages, deliberately: **Python** for the backend, **TypeScript** for the two admin
websites, **Dart** for mobile and desktop. The API is plain HTTP, so one backend serves every
client surface.

Two Cloud Run services for the backend — **API** and **worker** — plus the Next.js console.

---

## Client apps

| What | Tech | Notes |
|---|---|---|
| Resident app | **Flutter / Dart** | Android + iOS, one codebase |
| Guard app | **Flutter / Dart**, separate binary | Society-owned shared devices — different security posture, must not retain resident data past a shift |
| Desktop (when needed) | **Flutter Desktop** | Windows/macOS from the same Dart code |
| Society admin console | **Next.js 15** (TypeScript, App Router) | Route group `/society` |
| Super admin console | **Next.js 15** | Route group `/super` — same deployable |

## Backend

| What | Tech | Notes |
|---|---|---|
| API | **FastAPI, Python 3.12** | Modular monolith, not microservices |
| Background workers | **FastAPI / Python**, separate Cloud Run service | Approval-ladder timers, billing runs, SLA sweeps, notification fan-out |
| Dependencies | **uv** | Isolated venv, no global installs |
| Money arithmetic | **`decimal.Decimal`**, server-side only | Clients never compute money |

## Database

| What | Tech | Notes |
|---|---|---|
| Primary DB | **Neon Postgres 16**, Singapore | Autosuspend **disabled** (paid tier) — otherwise the first gate entry each morning waits for the DB to wake |
| Tenant isolation | **Postgres Row-Level Security** | `SET LOCAL app.society_id` inside every transaction |
| Migrations | **Alembic** | |
| Money columns | `numeric(18,4)` | Never float |

**Build rule.** Neon pools in PgBouncer *transaction* mode, so session state does not survive between
queries. Every query must run inside an explicit transaction via a single `tenant_context` async
context manager that opens the transaction and sets the GUC. Raw pool queries are banned by lint — a
query that escapes the wrapper silently loses tenant scoping.

## Infrastructure

| What | Tech | Notes |
|---|---|---|
| Runtime | **Google Cloud Run**, `asia-southeast1` (Singapore) | Co-located with Neon; min-instances ≥ 2 on API |
| Scheduled callbacks | **Cloud Tasks** | Drives the 20s/45s/90s approval ladder |
| Cron | **Cloud Scheduler** | Billing runs, SLA sweeps, invariant checks |
| Secrets | **Google Secret Manager** | Never in code |
| IaC | **Terraform** | From day 1 |
| CI/CD | **GitHub Actions** | Migrations gated, blue-green deploys |

**Region note.** Neon has no India region, so compute is co-located with it in Singapore. The
configuration to never build is Cloud Run in Mumbai with Neon in Singapore — every query would cross
the sea. Kept together the cost is ~40–60 ms once per request, which fits the 800 ms gate budget.

## Storage

| What | Tech | Notes |
|---|---|---|
| Photos & documents | **Cloudflare R2** | Private bucket, per-society prefix, links expire in minutes. Zero egress — critical at ~2M gate photos/day |

## Auth & security

| What | Tech | Notes |
|---|---|---|
| Login | **Phone OTP via MSG91** | Custom — one person can be resident in society A and MC in society B |
| Sessions | Short-lived JWT + rotating refresh token | Device binding on the guard app |
| 2FA | **TOTP**, mandatory | Accountant, admin, super-admin roles |
| Encryption | TLS 1.3 in transit, AES-256 at rest | |

## Payments

| What | Tech | Notes |
|---|---|---|
| Mode 1 — platform-managed | **Razorpay Route** | Split settlement direct to each society's bank. Keeps us out of RBI payment-aggregator licensing |
| Mode 1 — virtual accounts | **Razorpay Smart Collect** | Per-unit account numbers, auto-reconciles NEFT/IMPS/UPI |
| Mode 2 — direct merchant | **Bring-your-own merchant ID** | Owner/society's own gateway account, zero platform commission. See `PAYMENTS.md` |

## Messaging

| What | Tech | Notes |
|---|---|---|
| Push | **FCM + APNs** | The visitor-approval flow depends on this |
| SMS | **MSG91** | DLT-registered headers and templates |
| Voice / IVR | **Exotel** | The 20-second rung of the approval ladder |
| WhatsApp | **WhatsApp Business API** (Meta) | Notices, dues reminders — pre-approved templates |
| Email | **Resend or SES** | |

## AI

| What | Tech | Notes |
|---|---|---|
| OCR | **Claude API** | Bank statements, meter readings, staff ID documents |
| Voice complaints | **Claude API** | 8 regional languages |
| Notice prioritisation, billing anomalies | **Claude API** | Never auto-denies a person entry |

## Guard app offline engine

| What | Tech | Notes |
|---|---|---|
| Local store | **Drift (SQLite) + SQLCipher** | Key in Android Keystore |
| Offline passes | **Ed25519 signed QR** | Verified on-device, zero network |
| Sync | Append-only outbox, **UUIDv7** idempotency keys | Exponential backoff drain |

## Observability & testing

| What | Tech | Notes |
|---|---|---|
| Errors | **Sentry** | |
| Logs & traces | **OpenTelemetry → Cloud Logging / Cloud Trace** | |
| Tests | **pytest**, **Dart test**, **Playwright**, **k6** | |
| Billing parity | **`golden-vectors.json`** | Same fixture run by Python and Dart suites |

---

## Repo layout

```
apps/api/              FastAPI — uv-managed venv
apps/worker/           Python — Cloud Tasks + Scheduler handlers
apps/web-admin/        Next.js — (society)/ and (super)/ route groups
apps/mobile-resident/  Flutter
apps/mobile-guard/     Flutter
packages/shared-types/ generated from FastAPI OpenAPI → TS + Dart clients
packages/billing/      golden-vectors.json
infra/terraform/       Cloud Run, Cloud Tasks, Cloud Scheduler, Secret Manager, R2
```

## Decisions taken and rejected

| Considered | Chosen | Why |
|---|---|---|
| NestJS / TypeScript API | **FastAPI / Python** | Native `Decimal` for money; better Tally/Excel/PDF tooling for the migration work that gates growth |
| Postgres in Mumbai | **Neon, Singapore** | Owner's decision; Neon has no India region. Residency risk documented in the build plan |
| Microservices | **Modular monolith** | Distributed transactions across billing before product-market fit is a net loss |
| Schema-per-tenant | **Shared schema + RLS** | 1,000 schemas means 1,000 migrations per deploy |
| MongoDB alongside Postgres | **Postgres only** | ~2M gate events/day is a well-indexed Postgres problem, not a big-data one |
| GLM-OCR | **Claude only** | Removes a China-hosted dependency handling society bank statements |
| FASTag boom barriers | **UHF RFID** | FASTag parking requires an IHMCL-authorised acquirer bank |
