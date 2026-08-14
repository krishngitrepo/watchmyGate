# WatchMyGate — Data Model

Status: **design**. Last updated 13 Aug 2026.

Conventions used throughout:

- Primary keys are `uuid` (UUIDv7 where client-generated, for sortable idempotency keys).
- Every tenant-scoped table carries `society_id uuid not null` and an RLS policy.
- Money is `numeric(18,4)` with a `currency char(3)` alongside. Never float.
- Timestamps are `timestamptz`, stored UTC.
- Soft delete is avoided; use explicit status columns so queries cannot forget a filter.

---

## 1. Tenancy and identity

```sql
societies (
  id uuid pk, name text, slug text unique,
  state_code text,              -- drives the statutory rule-pack (MH / KA / ...)
  plan_tier enum(basic, pro, enterprise),
  timezone text default 'Asia/Kolkata',
  status enum(onboarding, active, suspended),
  created_at, updated_at
)

towers      (id, society_id, name, floors int)
units       (id, society_id, tower_id, number text, floor int,
             carpet_area_sqft numeric(10,2), bhk int,
             status enum(occupied, vacant, under_renovation),
             unique(society_id, tower_id, number))

persons (
  id uuid pk, phone text unique,        -- E.164, the login identity
  name text, email text,
  status enum(active, deactivated),
  created_at, updated_at
)
```

`persons` is deliberately **not** tenant-scoped: one human may be a resident in society A and a
committee member in society B. Tenant scoping happens on the relationship, not the person.

### The part competitors get wrong

Billing liability, voting rights and app access are three **different** relationships to the same
unit, and they routinely belong to different people — the owner votes while the tenant pays, and both
need access. Collapsing them into one "resident" field is the classic bug in this category.

```sql
unit_occupancies (
  id uuid pk, society_id uuid, unit_id uuid, person_id uuid,
  relationship enum(owner, tenant, family_member, occupant),
  is_billing_liable boolean not null default false,
  has_voting_right  boolean not null default false,
  has_app_access    boolean not null default true,

  valid_from date not null,        -- business time
  valid_to   date,                 -- null = current
  recorded_at timestamptz not null default now(),   -- system time
  superseded_at timestamptz,       -- bitemporal: never updated in place

  created_by uuid
)
```

**Bitemporal by design.** When someone says six weeks later "I actually moved out on the 3rd", we
insert a corrected row rather than editing history. Bills regenerate correctly from business time
while the audit trail retains what we believed and when. `superseded_at` marks rows replaced by a
correction.

```sql
roles            (id, code, name)     -- super_admin, society_admin, mc_member,
                                      -- accountant, auditor, guard, resident, staff
role_assignments (id, society_id, person_id, role_id,
                  scope_type enum(society, tower, unit), scope_id uuid,
                  valid_from, valid_to)
```

---

## 2. Gate and security

```sql
visitor_passes (
  id uuid pk, society_id uuid, unit_id uuid,
  created_by uuid,                       -- resident who issued it
  visitor_name text, visitor_phone text,
  visitor_hash text,                     -- hash embedded in the signed QR
  category enum(guest, delivery, cab, courier, service, staff),
  valid_from timestamptz, valid_to timestamptz,
  max_uses int default 1, uses int default 0,
  signature text not null,               -- Ed25519 over the canonical payload
  key_version int not null,              -- society signing key, rotated weekly
  status enum(active, used, expired, revoked)
)

society_signing_keys (
  id, society_id, key_version int, public_key text, private_key_ref text,
  valid_from, valid_to                   -- private key lives in Secret Manager
)

gate_events (
  id uuid pk,                            -- UUIDv7 generated on the guard device
  society_id uuid, gate_id uuid, unit_id uuid,
  pass_id uuid null,                     -- null for ad-hoc visitors
  guard_person_id uuid,
  direction enum(entry, exit),
  visitor_name text, visitor_phone text, vehicle_number text,
  photo_key text,                        -- R2 object key
  verified_offline boolean not null,     -- pass signature checked without network
  device_ts timestamptz not null,        -- guard device clock (untrusted)
  server_ts timestamptz not null default now(),
  clock_drift_seconds int,
  approval_id uuid null,
  created_at
)
-- partitioned monthly on server_ts
-- unique(id) gives idempotent replay for the offline outbox
```

```sql
approvals (
  id uuid pk, society_id uuid, unit_id uuid, gate_event_id uuid,
  state enum(pending, approved, denied, auto_approved, timed_out, escalated),
  requested_at timestamptz, resolved_at timestamptz,
  resolved_by uuid null, resolution_rung enum(push, ivr, standing_rule, mc_escalation),
  standing_rule_id uuid null
)

approval_rungs (            -- the audit of the ladder, one row per step fired
  id, approval_id, rung enum(push, ivr, sms, standing_rule, mc_escalation),
  fired_at timestamptz, channel_result text
)

standing_rules (            -- per unit: "always let Amazon in"
  id, society_id, unit_id, category, matcher text,
  action enum(auto_approve, ask_to_wait, deny), created_by
)

sos_alerts (id, society_id, person_id, unit_id, type enum(medical, fire, gas, security),
            lat, lng, raised_at, acknowledged_by, acknowledged_at, closed_at)

watchlist  (id, society_id, phone text, name text, reason text, added_by, active boolean)
```

---

## 3. Helpdesk

```sql
ticket_categories (id, society_id, parent_id, name,
                   default_assignee_id, sla_hours int, escalation_hours int)

tickets (
  id uuid pk, society_id uuid, ticket_number text,   -- human-facing, per society
  raised_by uuid, unit_id uuid null,                 -- null for common-area
  location_type enum(unit, tower, floor, amenity, common),
  location_ref uuid null,
  category_id uuid, title text, description text,
  status enum(open, in_progress, resolved, closed, reopened),
  priority enum(low, normal, high, urgent),
  assignee_id uuid null, vendor_id uuid null,
  sla_due_at timestamptz, escalated_at timestamptz,
  resolved_at timestamptz, rating int null, rating_comment text,
  duplicate_of uuid null,
  created_at, updated_at
)

ticket_events (id, ticket_id, actor_id, type enum(comment, status_change, assignment,
               internal_note, attachment, rating, reopen),
               body text, visibility enum(public, staff_only), created_at)

attachments (id, society_id, owner_type enum(ticket, ticket_event, gate_event, document),
             owner_id uuid, r2_key text, mime text, bytes int,
             kind enum(photo, video, voice, document), uploaded_by, created_at)
```

Attachments are always served through short-lived signed URLs scoped by `society_id`; a resident of
another society receives 404, never 403 (do not confirm existence).

---

## 4. Billing and ledger

```sql
ledger_accounts (
  id, society_id, code text, name text,
  type enum(asset, liability, income, expense, equity),
  parent_id uuid null, is_restricted boolean default false,   -- corpus / sinking fund
  unique(society_id, code)
)

journal_entries (
  id uuid pk, society_id uuid, entry_number text,
  entry_date date, narration text,
  source_type enum(invoice, receipt, payment, adjustment, opening, contra),
  source_id uuid, posted_at timestamptz, posted_by uuid,
  reverses_entry_id uuid null,        -- corrections are contra-entries, never edits
  period_id uuid
)

journal_lines (
  id, journal_entry_id, society_id, account_id,
  debit numeric(18,4) default 0, credit numeric(18,4) default 0,
  currency char(3) default 'INR', unit_id uuid null,
  check (debit >= 0 and credit >= 0),
  check ((debit = 0) <> (credit = 0))
)
```

**Immutability is enforced at the database, not in application code.** `UPDATE` and `DELETE` are
revoked from the application role on both journal tables, and a trigger raises on any attempt. The
only way to change a posted entry is a reversing entry.

```sql
accounting_periods (id, society_id, starts_on, ends_on,
                    status enum(open, locked), locked_by, locked_at,
                    reopened_by, reopened_approved_by)   -- two-person reopen
```

```sql
charge_types (id, society_id, code, name,
              formula enum(flat, per_sqft, per_bhk, per_meter, percentage, manual),
              rate numeric(18,4), account_id uuid,
              gst_applicable boolean, is_recurring boolean)

invoices (
  id uuid pk, society_id uuid, unit_id uuid, invoice_number text,
  period_start date, period_end date, issue_date date, due_date date,
  subtotal numeric(18,4), gst_amount numeric(18,4),
  late_fee numeric(18,4), total numeric(18,4),
  status enum(draft, issued, partially_paid, paid, void),
  liable_person_id uuid,        -- resolved from unit_occupancies at issue time
  journal_entry_id uuid
)

invoice_lines (id, invoice_id, society_id, charge_type_id, description,
               quantity numeric(18,4), rate numeric(18,4),
               amount numeric(18,4), gst_rate numeric(5,2), gst_amount numeric(18,4))

receipts (id, society_id, unit_id, receipt_number, received_on date,
          amount numeric(18,4), method enum(upi, card, netbanking, neft, cash, cheque),
          provider_payment_id text, provider_event_id text unique,   -- webhook idempotency
          destination_id uuid, journal_entry_id uuid)

receipt_allocations (id, receipt_id, invoice_id, society_id, amount numeric(18,4))
```

`provider_event_id unique` is what makes webhook replay safe — Razorpay retries aggressively, and an
insert conflict is the correct, boring outcome.

### Payment routing

```sql
payment_destinations (
  id, society_id, payee_type enum(society, person), payee_id uuid,
  mode enum(route_linked, direct_merchant),
  provider enum(razorpay, cashfree),
  merchant_id text, credentials_secret_ref text, webhook_secret_ref text,
  status enum(pending, verified, failed, disabled), verified_at
)

charge_type_routing (society_id, charge_type_code, destination_id)
```

Credentials are **references to Secret Manager paths**, never the secrets themselves. See
`PAYMENTS.md`.

---

## 5. Communication, facility, staff

```sql
notices (id, society_id, title, body, author_id,
         audience_type enum(society, tower, unit_list, role), audience_ref jsonb,
         channels text[], published_at, expires_at, priority int)

notice_receipts (id, notice_id, person_id, delivered_at, read_at, channel)

amenities (id, society_id, name, capacity int, slot_minutes int,
           is_paid boolean, rate numeric(18,4), rules jsonb)

amenity_bookings (id, society_id, amenity_id, unit_id, booked_by,
                  starts_at, ends_at, status enum(confirmed, cancelled),
                  invoice_id uuid null,
                  exclude using gist (amenity_id with =, tstzrange(starts_at, ends_at) with &&)
                    where (status = 'confirmed'))
```

The exclusion constraint is what actually prevents double-booking — application-level checks race
under concurrency and eventually lose.

```sql
documents (id, society_id, title, category, r2_key,
           visibility enum(public, residents, mc_only, accountant_only),
           uploaded_by, version int, created_at)

staff (id, society_id, person_id, type enum(domestic_help, maintenance, security, vendor_staff),
       employer_unit_id uuid null, verification_status enum(pending, verified, rejected),
       verification_ref text,        -- DigiLocker result; NEVER an Aadhaar number
       police_verification_expiry date)

attendance (id, society_id, staff_id, unit_id null, check_in timestamptz,
            check_out timestamptz, method enum(biometric, pin, card, manual),
            recorded_by uuid null)

vendors (id, society_id, name, category, phone, gstin, rating numeric(3,2), active boolean)
```

Biometric attendance is opt-in with a PIN or card alternative always available — domestic staff
cannot meaningfully refuse an employer's demand, so consent must be structurally real. Biometric
templates are irreversible and stored at the edge, never as centrally-held face images.

---

## 6. Consent and audit

```sql
consents (
  id, society_id null, person_id uuid,
  purpose text, notice_version text, notice_text_hash text,
  granted boolean, granted_at timestamptz, withdrawn_at timestamptz,
  source enum(app, web, paper), ip inet, created_at
)
-- append-only: withdrawal is a new row, not an update

audit_log (
  id uuid pk, society_id uuid null, actor_person_id uuid null,
  action text, entity_type text, entity_id uuid,
  before jsonb, after jsonb, reason text,
  ip inet, user_agent text, created_at timestamptz default now()
)
-- partitioned monthly; INSERT-only grant for the application role
```

Every financial posting, every access-control change, every credential read and every CCTV or
attachment access writes an `audit_log` row. This is a DPDP requirement and an auditor requirement,
and it is cheaper to build now than to retrofit.

---

## 7. Row-Level Security

Applied to every table carrying `society_id`:

```sql
alter table gate_events enable row level security;
alter table gate_events force row level security;

create policy tenant_isolation on gate_events
  using      (society_id = current_setting('app.society_id', true)::uuid)
  with check (society_id = current_setting('app.society_id', true)::uuid);
```

The application connects as `watchmygate_app`, a role created **`NOBYPASSRLS`** and without table
ownership. `super_admin` operations use a separate role and an explicit, audited elevation path — not
a bypass flag on the normal connection.

`current_setting('app.society_id', true)` returns null when unset, and the comparison then yields
false, so an unscoped query returns **zero rows** rather than everything. Failing closed is the
whole point.

---

## 8. Indexing notes

- `gate_events`: partition monthly on `server_ts`; index `(society_id, unit_id, server_ts desc)` and
  `(society_id, server_ts desc)`.
- `invoices`: `(society_id, unit_id, status)` and `(society_id, due_date) where status <> 'paid'`
  for defaulter queries.
- `tickets`: `(society_id, status, sla_due_at)` drives the escalation sweep.
- `unit_occupancies`: `(society_id, unit_id, valid_from desc) where valid_to is null` for the common
  "who lives here now" lookup.
- `journal_lines`: `(society_id, account_id)` and `(journal_entry_id)`.

At 250k units and ~2M gate events/day this stays comfortably within a single well-tuned Postgres.
