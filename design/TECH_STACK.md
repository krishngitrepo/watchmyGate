# WatchMyGate — Tech Stack

Status: **decided**. Last updated 14 Aug 2026.

## The organising principle

**TypeScript owns money. Python owns machines and models.**

Everything touching a financial transaction — billing, the ledger, payments, invoices —
is TypeScript, because the billing calculator must produce byte-identical results in
the browser, on the server and in the desktop app. TypeScript is the only language that
runs in all three, so the calculator is written once and imported everywhere.

Python is used only where it is genuinely better: generative AI, OCR, computer vision,
and talking to physical hardware (cameras, ANPR, RFID readers, boom barriers). It is a
**separate service that never touches the database** — it calls the TypeScript API like
any other client.

That boundary is the whole design. One writer for money, one audit path, one set of
tenant-isolation plumbing.

---

## Services

| Service | Language | Responsibility |
|---|---|---|
| `apps/api` | **TypeScript** (NestJS) | Auth, societies, units, helpdesk, gate records, **billing, ledger, payments**. Owns the database. |
| `apps/worker` | **TypeScript** | Cloud Tasks + Scheduler handlers: approval-ladder timers, billing runs, SLA sweeps, notification fan-out |
| `apps/ai-service` | **Python** (FastAPI) | GenAI, OCR, voice transcription, ANPR/camera, gate hardware. **No database access** — calls `apps/api` |
| `apps/web-admin` | **TypeScript** (Next.js 15, static export) | Society and super-admin consoles |
| `apps/desktop` | **Tauri** (Rust shell) | Wraps the same Next.js admin build as a native desktop app |
| `apps/mobile-resident` | **Dart** (Flutter) | Resident app |
| `apps/mobile-guard` | **Dart** (Flutter) | Guard app, offline-first |

---

## The money package — why this stack exists

`packages/money` is TypeScript, imported unchanged by the API, the worker, the Next.js
admin and the Tauri desktop build. GST slabs, per-sq-ft and per-BHK formulas, sinking
fund, late-fee interest and rounding all live there once. The total a resident sees, the
total an accountant edits, and the total filed for GST are produced by the same code.

**TypeScript has no native decimal, and that is the one real hazard here.** JavaScript
`Number` is a binary float — `0.1 + 0.2 !== 0.3`. Sharing a calculator that uses floats
would guarantee both sides are wrong *identically*, which is worse than them
disagreeing, because nothing would ever flag it.

So, non-negotiably:

- All money is **`decimal.js`**, never `number`.
- Currency values use a branded type so a raw `number` cannot be passed by accident.
- A lint rule bans `+ - * /` on any currency-typed value; arithmetic goes through the
  package's functions.
- Postgres columns are `numeric(18,4)`; the driver maps them to `Decimal`, never float.
- Rounding is **half-up** at two decimals for anything invoiced — Indian statutory
  invoicing expects it, and a committee checking against a spreadsheet treats banker's
  rounding as a bug.

**Flutter cannot import the package**, so it is held honest by test rather than trust:
`packages/money/golden-vectors.json` pairs inputs with expected outputs across every GST
slab, formula, late-fee accrual and rounding edge, and is executed by the TypeScript
suite *and* the Dart suite. Neither can drift without a red build.

---

## Backend detail

| Concern | Choice | Why |
|---|---|---|
| Framework | **NestJS** | Module boundaries enforced natively, matching the modular-monolith design |
| ORM | **Drizzle** | SQL-first with real TypeScript types; raw SQL inside transactions is first-class, which the RLS scoping needs |
| Migrations | **Drizzle Kit**, plain SQL files | The RLS policies and grants are already written and verified as SQL; keeping them as SQL preserves that work |
| Money type | **decimal.js** | See above |
| Validation | **Zod** | Runtime validation that generates the TypeScript types, so the API contract has one source |
| Logging | **Pino** | Structured JSON, fast |
| Tests | **Vitest** | |
| Lint / format | **ESLint + Prettier**, with the money arithmetic rule | |

## Python service detail

| Concern | Choice |
|---|---|
| Framework | **FastAPI**, Python 3.12, `uv`-managed venv |
| Purpose | Claude API calls (OCR of bank statements, meter readings, staff IDs; voice complaint transcription), ANPR/camera integration, RFID and boom-barrier drivers |
| Database | **None.** Reads and writes go through `apps/api` over HTTP with a service token |
| Auth | Service-to-service token, scoped to the endpoints it needs |

Keeping it stateless means the AI and device work can crash, restart or scale
independently without any risk to financial data.

---

## Data

| Layer | Choice | Notes |
|---|---|---|
| Database | **Neon Postgres 16, Singapore** | Autosuspend **disabled** — otherwise the first gate entry each morning waits for the DB to wake |
| Tenant isolation | **Row-Level Security**, `NOBYPASSRLS` app role | Unscoped queries return zero rows, never everything |
| Money columns | `numeric(18,4)` | |

**Build rule.** Neon pools in transaction mode, so session state does not survive
between queries. Every query runs inside an explicit transaction that first sets
`app.society_id`. One helper does this; raw pool access is banned by lint. A query that
escapes it silently loses tenant scoping.

---

## Infrastructure

| Layer | Choice |
|---|---|
| Runtime | **Google Cloud Run**, `asia-southeast1` (co-located with Neon), min 2 warm instances on the API |
| Jobs & timers | **Cloud Tasks** (approval ladder) + **Cloud Scheduler** (billing runs, SLA sweeps) |
| Secrets | **Google Secret Manager** |
| Storage | **Cloudflare R2** — private bucket, per-society prefix, short-lived signed URLs |
| IaC | **Terraform** |
| CI/CD | **GitHub Actions**, migrations gated, tenant-isolation tests a required check |

## External services

| Purpose | Provider |
|---|---|
| Collections | **Razorpay Route** + **Smart Collect**; direct-merchant mode for owner-collected rent |
| SMS / OTP | **MSG91** (DLT-registered templates) |
| Voice / IVR | **Exotel** (the 20-second approval rung) |
| Push | **FCM + APNs** |
| WhatsApp | **Meta Business API** |
| AI / OCR | **Claude API** (via the Python service) |
| Monitoring | **Sentry** + OpenTelemetry → Cloud Logging |

---

## Repository layout

```
apps/api/              TypeScript — NestJS. Owns the database and all money.
apps/worker/           TypeScript — Cloud Tasks/Scheduler handlers
apps/ai-service/       Python — FastAPI. GenAI, OCR, camera, gate devices. No DB.
apps/web-admin/        Next.js 15 (static export) — society and super-admin consoles
apps/desktop/          Tauri — wraps the web-admin static build
apps/mobile-resident/  Flutter
apps/mobile-guard/     Flutter, offline-first
packages/money/        decimal.js calculator + golden-vectors.json
packages/db/           Drizzle schema + SQL migrations (RLS policies live here)
packages/shared-types/ Zod schemas → TS types, and generated Dart clients
infra/terraform/       Cloud Run, Cloud Tasks, Scheduler, Secret Manager, R2
design/                Architecture and compliance documentation
```

Four languages, each with a reason: **TypeScript** (money, API, admin, desktop UI),
**Python** (AI and hardware only), **Dart** (mobile), **Rust** (Tauri shell — generated,
rarely edited by hand).

---

## Decisions taken and rejected

| Considered | Chosen | Why |
|---|---|---|
| Python/FastAPI for everything | **TypeScript for money, Python for AI/devices** | The billing calculator must run identically in browser, server and desktop. Python cannot run in a browser. |
| Python service with its own DB access | **No database access; calls the API** | Two writers to financial tables means two sets of RLS plumbing and two audit paths |
| Electron for desktop | **Tauri** | Far smaller binary, lower memory, and it reuses the admin build unchanged |
| Reflex / HTMX admin console | **Next.js** | Tauri renders web content, and TypeScript lets the money package run in the desktop app too |
| Next.js with SSR / API routes | **Next.js static export** (`output: 'export'`) | Tauri bundles static files, so no server-side rendering. No loss here — the API is a separate service, so Next.js is doing UI only |
| `number` for currency | **decimal.js + branded type + lint ban** | JS floats silently corrupt money; sharing float code makes both sides wrong identically |
| Postgres in Mumbai | **Neon, Singapore** | Owner's decision. Neon has no India region; residency risk documented in SECURITY_COMPLIANCE.md |
| Microservices | **Modular monolith + one AI/device service** | The split is along a real boundary (money vs machines), not an arbitrary one |
| Schema-per-tenant | **Shared schema + RLS** | 1,000 schemas means 1,000 migrations per deploy |
| MongoDB alongside Postgres | **Postgres only** | ~2M gate events/day is a well-indexed Postgres problem |
| GLM-OCR | **Claude only** | Removes a China-hosted dependency handling society bank statements |
| FASTag boom barriers | **UHF RFID** | FASTag parking requires an IHMCL-authorised acquirer bank |
