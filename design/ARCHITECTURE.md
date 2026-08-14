# WatchMyGate — System Architecture

Status: **decided**. Last updated 13 Aug 2026.
Companion documents: `TECH_STACK.md`, `DATA_MODEL.md`, `PAYMENTS.md`, `SECURITY_COMPLIANCE.md`,
`ROLLOUT.md`.

---

## 1. Shape of the system

```
┌──────────────┐  ┌──────────────┐  ┌───────────────┐
│ Resident app │  │  Guard app   │  │ Admin console │
│   Flutter    │  │   Flutter    │  │   Next.js     │
│              │  │  OFFLINE-    │  │  society/super│
└──────┬───────┘  │   FIRST      │  └───────┬───────┘
       │          └──────┬───────┘          │
       └─────────────────┼──────────────────┘
                         │ HTTPS / JSON
                ┌────────▼─────────┐
                │   FastAPI API    │  Cloud Run, min-instances ≥ 2
                │ modular monolith │  asia-southeast1
                └────────┬─────────┘
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
┌───────▼──────┐ ┌───────▼──────┐ ┌────────▼────────┐
│Neon Postgres │ │ Cloud Tasks  │ │  Cloudflare R2  │
│  Singapore   │ │  + Scheduler │ │  photos / docs  │
│  RLS enabled │ └───────┬──────┘ └─────────────────┘
└──────────────┘         │
                 ┌───────▼────────┐
                 │ Python worker  │  Cloud Run, scales to zero
                 │ timers · bills │
                 │ SLA · fan-out  │
                 └───────┬────────┘
                         │
        ┌────────────────┼──────────────┬──────────────┐
   ┌────▼────┐    ┌──────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
   │FCM/APNs │    │   MSG91    │  │  Exotel   │  │ Razorpay  │
   │  push   │    │    SMS     │  │    IVR    │  │Route/S.C. │
   └─────────┘    └────────────┘  └───────────┘  └───────────┘
```

**Two backend deployables.** The API answers requests. The worker runs everything that is not a
request — because Cloud Run terminates a container the moment it returns a response, timers and
batch jobs cannot live in the API.

---

## 2. Modular monolith, not microservices

One FastAPI deployable with hard module boundaries. Five services would mean distributed
transactions across billing and 5× the ops burden before product-market fit.

```
app/modules/
  auth/  society/  gate/  billing/  ledger/  payments/  helpdesk/  notify/  staff/  facility/
```

**Boundary rule, enforced by lint:** a module may import from `app/common/` and from its own
package. Cross-module access goes through the target module's `service.py` public functions — never
by reaching into another module's `repository.py` or models. This keeps extraction cheap if a module
ever needs to become its own service.

Realistically only two things will ever need extracting: the notification fan-out worker (already
separate) and the gate-entry read path.

---

## 3. Multi-tenancy

**Shared schema, `society_id` on every table, Postgres Row-Level Security.**

Rejected: schema-per-tenant. At 1,000 societies that is 1,000 migrations per deploy, connection-pool
explosion, and Postgres catalog bloat.

### How isolation is enforced

1. Every tenant-scoped table carries `society_id uuid not null`.
2. An RLS policy on each table restricts rows to `society_id = current_setting('app.society_id')`.
3. The application connects as a **non-superuser role with `NOBYPASSRLS`** — it is not capable of
   seeing across tenants even if application code is wrong.
4. Every request resolves `society_id` from the authenticated session and sets it for the
   transaction.

### The Neon constraint that shapes this

Neon pools connections in **PgBouncer transaction mode**, so session state does not survive between
queries. `SET LOCAL` is transaction-scoped and therefore works — but only inside an explicit
transaction.

**Build rule:** every database access goes through one `tenant_context` async context manager that
opens a transaction, sets the GUC, and yields the session. Raw pool access is banned by lint. A
query that escapes this wrapper silently loses tenant scoping, which is the worst bug this product
could ship. The cross-tenant leak test in CI is what catches it, and that test failing fails the
build.

### Graduating a large tenant

A whale or white-label society moves to a dedicated database via a `tenant_routing` lookup
(`society_id → connection string`). Same application code, no schema change.

---

## 4. The offline gate

The hardest subsystem, and the clearest differentiator. Guards work at barriers with poor or no
connectivity.

### Offline-verifiable visitor passes

The server issues an **Ed25519-signed compact pass**. The QR encodes:

```
{ pass_id, unit_id, valid_from, valid_to, visitor_hash, sig }
```

The guard app verifies the signature **locally** against a cached society public key, rotated
weekly. A pre-approved visitor therefore enters with **zero network**. No competitor does this
cleanly, and it is the demonstration that sells the product to a committee.

### Append-only outbox

Gate entries are *events*, so they are conflict-free by construction — there is no merge problem,
only an ordering problem.

- Local store: **Drift (SQLite) under SQLCipher**, key held in Android Keystore.
- Every record carries a client-generated **UUIDv7 idempotency key**.
- Sync drains in order with exponential backoff; the server deduplicates on the idempotency key.
- Replaying the same payload N times must produce exactly one row. This is tested explicitly.

### Clock skew is assumed, not hoped away

Guard device clocks are routinely wrong by hours. Every event stores `device_ts` **and** a
server-assigned `server_ts`. All business logic uses `server_ts`; the audit trail shows both plus the
computed drift.

### Data minimisation on shared devices

Guard devices are society property, shared across shifts. The guard app holds only what the current
shift needs, purges resident PII on shift end, and is bound to a registered device ID that an admin
can revoke.

---

## 5. The approval ladder

The original brief asked for "gate entry approval under 2 seconds". That is physically impossible —
the round trip includes a human being tapping a button. The real design is a ladder, and the
resident-did-not-answer case (the single biggest complaint against incumbent products) is a designed
feature rather than an edge case.

| t | Action | Target |
|---|---|---|
| 0 s | Guard submits → server acknowledges | **p95 < 800 ms** |
| 0 s | High-priority data push to every device on the unit | p95 < 3 s |
| 20 s | No response → IVR call (Exotel) + SMS to primary resident | |
| 45 s | No response → apply the unit's **standing rule** (auto-approve trusted categories such as a known delivery partner, otherwise "ask to wait") | |
| 90 s | Escalate to the on-duty MC contact | |

Implemented with **Cloud Tasks scheduled delivery** — one task enqueued per rung at creation time,
each cancelled if the resident responds first. Every rung is written to the audit log and shown to
the resident afterwards, so "I never got the notification" becomes checkable.

---

## 6. Money

Detailed rules in `PAYMENTS.md` and `DATA_MODEL.md`. Architectural invariants:

- **Double-entry, immutable journal.** No `UPDATE` or `DELETE` on posted lines — enforced by
  revoking the grant *and* by trigger, not by application discipline. Corrections are contra-entries.
- **`numeric(18,4)`** in Postgres, **`decimal.Decimal`** in Python. Never float.
- **Money is computed server-side only.** Clients display what the API returns; live totals come from
  `POST /billing/preview`. One implementation, so the resident's total and the GST filing cannot
  differ by a paisa.
- **Scheduled invariant checks:** Σdebits = Σcredits per journal; ledger balance = Σ lines; unit
  outstanding = Σ invoices − Σ allocated receipts. Drift pages an engineer.
- **Period locking** after MC sign-off; reopening requires two-person approval and is audit-logged.
- **Idempotent webhooks** keyed on the provider event id — Razorpay retries aggressively.

---

## 7. Notifications

One `notify` module abstracting four channels behind a single interface, with per-channel policy:

| Channel | Provider | Constraint |
|---|---|---|
| Push | FCM / APNs | Data-only high-priority messages for approvals |
| SMS | MSG91 | **DLT-registered** headers and templates; category enforced per template |
| Voice | Exotel | IVR for the 20 s ladder rung |
| WhatsApp | Meta Business API | Pre-approved templates, explicit opt-in |
| Email | Resend / SES | |

Template category is part of the template definition, not a runtime flag — TRAI rules differ for
transactional, service-explicit and promotional messages, and only the first two may reach numbers on
the DND registry.

---

## 8. Observability and SLOs

| Signal | Target |
|---|---|
| Gate submit → server ack | p95 < 800 ms |
| Push delivery to resident | p95 < 3 s |
| API availability | 99.9% |
| Offline sync success within 5 min of reconnect | > 99% |
| Guard app crash-free sessions | > 99.5% |

OpenTelemetry traces to Cloud Trace, structured logs to Cloud Logging, errors to Sentry. Alerts on
SLO burn rate, ledger invariant drift, webhook failure rate, and sync backlog depth.

**RPO 5 minutes, RTO 1 hour.** Restore drills quarterly — a backup that has never been restored is
not a backup.

---

## 9. Environments

| Env | Purpose | Data |
|---|---|---|
| local | docker-compose Postgres, all externals stubbed | Seeded fixtures |
| dev | Neon branch, Cloud Run dev service | Synthetic |
| staging | Neon branch off production schema | Anonymised |
| production | Neon primary, Cloud Run, min-instances ≥ 2 | Live |

Neon's database branching is used for per-PR ephemeral databases in CI — this is the main reason
Neon earns its place despite having no India region.

---

## 10. What this architecture deliberately does not do

- **No microservices** until a module proves it needs independent scaling.
- **No MongoDB.** ~2M gate events/day across 250k units is a well-indexed Postgres problem. Monthly
  partitioning handles logs and feeds. Revisit ClickHouse only when analytics volume demands it.
- **No client-side money arithmetic.** Ever.
- **No AI in the deny path.** Anomaly detection flags to the MC on aggregate signals; it never
  auto-denies a person entry. Profiling delivery workers and domestic staff is both a DPDP
  significant-harm exposure and wrong on the merits.
