# WatchMyGate

Multi-tenant gated-community management platform — visitor security, society accounting, and
resident helpdesk for apartment and villa communities in India.

**Status:** Phase 0 (foundation). See [FEATURES.md](FEATURES.md) for scope and
[AUDIT_TRAIL.md](AUDIT_TRAIL.md) for the decision history.

---

## Documentation

| Document | Contents |
|---|---|
| [design/TECH_STACK.md](design/TECH_STACK.md) | Every technology choice, and what was rejected |
| [design/ARCHITECTURE.md](design/ARCHITECTURE.md) | System design, multi-tenancy, offline gate, approval ladder |
| [design/DATA_MODEL.md](design/DATA_MODEL.md) | Schema across all modules |
| [design/PAYMENTS.md](design/PAYMENTS.md) | Both collection modes, RBI position, security of merchant credentials |
| [design/SECURITY_COMPLIANCE.md](design/SECURITY_COMPLIANCE.md) | DPDP, RBI, TRAI, Aadhaar, GST, state law |
| [design/ROLLOUT.md](design/ROLLOUT.md) | Revenue model and the path from 3 to 1,000 societies |

---

## Stack at a glance

**Backend** FastAPI (Python 3.12) · **DB** Neon Postgres 16 with Row-Level Security ·
**Runtime** Google Cloud Run, `asia-southeast1` · **Jobs** Cloud Tasks + Cloud Scheduler ·
**Storage** Cloudflare R2 · **Secrets** Google Secret Manager ·
**Admin web** Next.js 15 · **Mobile** Flutter (resident + guard) ·
**Payments** Razorpay Route + Smart Collect · **SMS/OTP** MSG91 · **AI/OCR** Claude API

Three languages, deliberately: Python (backend), TypeScript (admin consoles), Dart (mobile and
desktop). The API is plain HTTP, so one backend serves every client.

---

## Repository layout

```
apps/api/              FastAPI — request handling
apps/worker/           Python — Cloud Tasks + Scheduler handlers (timers, billing runs, fan-out)
apps/web-admin/        Next.js — society and super-admin consoles
apps/mobile-resident/  Flutter
apps/mobile-guard/     Flutter, offline-first
packages/shared-types/ generated from FastAPI OpenAPI → TypeScript + Dart clients
packages/billing/      golden-vectors.json — billing parity fixture
infra/terraform/       Cloud Run, Cloud Tasks, Scheduler, Secret Manager, R2
design/                Architecture and compliance documentation
```

---

## Local setup

Requires **Docker**, **Python 3.12** and [**uv**](https://docs.astral.sh/uv/).

```bash
# 1. Start Postgres locally (no cloud account needed for development)
docker compose up -d

# 2. Install dependencies into an isolated venv
cd apps/api
uv sync

# 3. Configure environment
cp ../../.env.example ../../.env        # defaults work against docker-compose

# 4. Apply migrations (creates schema, roles and RLS policies)
uv run alembic upgrade head

# 5. Seed two societies and sample data — used by the isolation tests
uv run python -m app.scripts.seed

# 6. Run
uv run uvicorn app.main:app --reload --port 8000
```

API docs at `http://localhost:8000/docs`. Health check at `/healthz`.

No cloud credentials are needed to develop locally — MSG91, Razorpay, R2 and Claude are stubbed
unless real keys are present in `.env`. In stub mode, OTPs are written to the application log
instead of being sent by SMS.

---

## Tests

```bash
cd apps/api
uv run pytest                       # everything
uv run pytest -m isolation          # cross-tenant leak tests only
```

**The cross-tenant isolation test is a required build gate.** It authenticates as society A and
attempts to read society B's rows across every tenant-scoped table; any row returned fails the
build. A query that escapes the `tenant_context` wrapper silently loses tenant scoping, which is the
worst defect this product could ship — this test is what catches it.

---

## Conventions

- Money is `numeric(18,4)` in Postgres and `decimal.Decimal` in Python. **Never float.**
- Money is computed **server-side only**. Clients display what the API returns; live totals during
  editing come from `POST /billing/preview`.
- Every database access goes through `app.common.tenancy.tenant_context`. Raw pool access is banned
  by lint.
- Posted journal entries are immutable — `UPDATE`/`DELETE` are revoked at the database. Corrections
  are contra-entries.
- No secrets in code or in committed env files. Google Secret Manager only.

---

## Credentials needed to deploy

Not required for local development.

**Before deploying:** Google Cloud project with billing (Cloud Run, Cloud Tasks, Cloud Scheduler,
Secret Manager — region `asia-southeast1`) · Neon account, paid tier, Singapore, autosuspend
disabled · Cloudflare account for R2.

**Before payments work:** Razorpay keys with **Route and Smart Collect enabled** · MSG91 account with
DLT-registered sender IDs and templates · WhatsApp Business API approval from Meta · Exotel
credentials · Anthropic API key · Google Play and Apple Developer accounts.
