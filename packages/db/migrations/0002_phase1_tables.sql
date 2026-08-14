-- Phase 1 tables: helpdesk, gate, ledger, billing, payments.
--
-- This is the DDL for every table defined in packages/db/src/schema.ts beyond the
-- foundation set. It is hand-written rather than emitted by Drizzle Kit, and kept in
-- parity with schema.ts by `schema-parity.test.ts`, which introspects the live database
-- and fails on any drift. That test is the contract — if you add a column here, add it
-- there, and the test tells you if you forgot.
--
-- Policies, triggers and grants live in 0003. Tables first, controls on top.
--
-- Conventions:
--   * Money is numeric(18,4). Never float, ever. The pg type parser hands it back as a
--     string so it reaches packages/money as a Decimal without passing through a double.
--   * Every tenant table carries society_id and gets an RLS policy in 0003.
--   * Timestamps are timestamptz, stored UTC. Dates that mean a calendar day are `date`.

-- ------------------------------------------------------------------- enums
DO $$ BEGIN
  CREATE TYPE ticket_status AS ENUM ('open','in_progress','resolved','closed','reopened');
  CREATE TYPE ticket_priority AS ENUM ('low','normal','high','urgent');
  CREATE TYPE ticket_location_type AS ENUM ('unit','tower','floor','amenity','common');
  CREATE TYPE ticket_event_type AS ENUM ('comment','status_change','assignment',
    'internal_note','attachment','rating','reopen','escalation');
  CREATE TYPE ticket_event_visibility AS ENUM ('public','staff_only');
  CREATE TYPE attachment_kind AS ENUM ('photo','video','voice','document');
  CREATE TYPE visitor_category AS ENUM ('guest','delivery','cab','courier','service','staff');
  CREATE TYPE pass_status AS ENUM ('active','used','expired','revoked');
  CREATE TYPE gate_direction AS ENUM ('entry','exit');
  CREATE TYPE approval_state AS ENUM ('pending','approved','denied','auto_approved',
    'timed_out','escalated');
  CREATE TYPE approval_rung AS ENUM ('push','ivr','sms','standing_rule','mc_escalation');
  CREATE TYPE standing_action AS ENUM ('auto_approve','ask_to_wait','deny');
  CREATE TYPE sos_type AS ENUM ('medical','fire','gas','security');
  CREATE TYPE account_type AS ENUM ('asset','liability','income','expense','equity');
  CREATE TYPE journal_source_type AS ENUM ('invoice','receipt','payment','adjustment',
    'opening','contra');
  CREATE TYPE period_status AS ENUM ('open','locked');
  CREATE TYPE invoice_status AS ENUM ('draft','issued','partially_paid','paid','void');
  CREATE TYPE billing_formula AS ENUM ('flat','per_sqft','per_bhk','per_meter',
    'percentage','manual');
  CREATE TYPE payment_method AS ENUM ('upi','card','netbanking','neft','cash','cheque');
  CREATE TYPE payee_type AS ENUM ('society','person');
  CREATE TYPE destination_mode AS ENUM ('route_linked','direct_merchant');
  CREATE TYPE destination_status AS ENUM ('pending','verified','failed','disabled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ==========================================================================
-- Helpdesk — the resident complaint flow
-- ==========================================================================

-- Per-society category tree. "Common Area → Lift → Lighting" is three rows, and the
-- SLA is attached to the leaf so a lift outage can be tighter than a garden complaint.
CREATE TABLE IF NOT EXISTS ticket_categories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id          uuid NOT NULL REFERENCES societies(id),
  parent_id           uuid REFERENCES ticket_categories(id),
  name                varchar(120) NOT NULL,
  -- Auto-routing target. Assignee wins if both are set.
  default_assignee_id uuid,
  default_vendor_id   uuid,
  sla_hours           integer NOT NULL DEFAULT 24,
  escalation_hours    integer NOT NULL DEFAULT 48,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_category_society ON ticket_categories (society_id);

CREATE TABLE IF NOT EXISTS tickets (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id                uuid NOT NULL REFERENCES societies(id),
  -- Human-facing, per society. Residents quote it on the phone.
  ticket_number             varchar(24) NOT NULL,
  raised_by                 uuid NOT NULL REFERENCES persons(id),
  -- Null for common-area issues: the lift belongs to the tower, not to a flat.
  unit_id                   uuid REFERENCES units(id),
  location_type             ticket_location_type NOT NULL,
  location_ref              uuid,
  location_note             varchar(200),
  category_id               uuid NOT NULL REFERENCES ticket_categories(id),
  title                     varchar(200) NOT NULL,
  description               text,
  -- Set when filed by voice, so the original language is preserved for the record.
  voice_transcript_language varchar(8),
  status                    ticket_status   NOT NULL DEFAULT 'open',
  priority                  ticket_priority NOT NULL DEFAULT 'normal',
  assignee_id               uuid,
  vendor_id                 uuid,
  sla_due_at                timestamptz NOT NULL,
  escalation_due_at         timestamptz NOT NULL,
  escalated_at              timestamptz,
  resolved_at               timestamptz,
  resolved_by               uuid,
  closed_at                 timestamptz,
  rating                    integer,
  rating_comment            varchar(500),
  -- Set when merged into an earlier report of the same problem.
  duplicate_of              uuid REFERENCES tickets(id),
  reopen_count              integer NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_society_number
  ON tickets (society_id, ticket_number);
CREATE INDEX IF NOT EXISTS ix_ticket_society_status ON tickets (society_id, status);
CREATE INDEX IF NOT EXISTS ix_ticket_sla_due        ON tickets (society_id, sla_due_at);
CREATE INDEX IF NOT EXISTS ix_ticket_raised_by      ON tickets (society_id, raised_by);

CREATE TABLE IF NOT EXISTS ticket_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id   uuid,
  type       ticket_event_type NOT NULL,
  body       text,
  -- staff_only notes are filtered out before the resident ever sees the thread.
  visibility ticket_event_visibility NOT NULL DEFAULT 'public',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ticket_event_ticket
  ON ticket_events (society_id, ticket_id, created_at);

-- Everyone notified: reporter, assignee, committee, and reporters of merged duplicates.
CREATE TABLE IF NOT EXISTS ticket_subscribers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  ticket_id  uuid NOT NULL REFERENCES tickets(id)  ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES persons(id)  ON DELETE CASCADE,
  reason     varchar(40) NOT NULL DEFAULT 'reporter',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_subscriber
  ON ticket_subscribers (ticket_id, person_id);

-- A file in R2. The row records the key; the bytes never pass through the API.
CREATE TABLE IF NOT EXISTS attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id),
  owner_type     varchar(32) NOT NULL,
  owner_id       uuid NOT NULL,
  r2_key         varchar(500) NOT NULL UNIQUE,
  content_type   varchar(120) NOT NULL,
  bytes          integer NOT NULL,
  kind           attachment_kind NOT NULL,
  uploaded_by    uuid,
  -- Distinguishes the repair evidence from the resident's original photos.
  is_proof_of_fix boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_attachment_owner
  ON attachments (society_id, owner_type, owner_id);

-- ==========================================================================
-- Gate
-- ==========================================================================

-- Rotated weekly. Guard devices cache the last few versions so a pass signed just
-- before a rotation still verifies on a handset that has not synced.
CREATE TABLE IF NOT EXISTS society_signing_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      uuid NOT NULL REFERENCES societies(id),
  key_version     integer NOT NULL,
  public_key      varchar(120) NOT NULL,
  -- Reference to Secret Manager. The private key is never stored in Postgres.
  private_key_ref varchar(300) NOT NULL,
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_signing_key_version
  ON society_signing_keys (society_id, key_version);

CREATE TABLE IF NOT EXISTS gates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  name       varchar(80) NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_gate_society_name ON gates (society_id, name);

CREATE TABLE IF NOT EXISTS visitor_passes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id),
  unit_id        uuid NOT NULL REFERENCES units(id),
  created_by     uuid NOT NULL REFERENCES persons(id),
  visitor_name   varchar(120) NOT NULL,
  visitor_phone  varchar(16),
  -- Salted and non-reversible: the QR gets photographed and forwarded on WhatsApp,
  -- so it must not be a readable disclosure of who is visiting whom.
  visitor_hash   varchar(64) NOT NULL,
  visitor_salt   varchar(32) NOT NULL,
  category       visitor_category NOT NULL,
  vehicle_number varchar(20),
  valid_from     timestamptz NOT NULL,
  valid_to       timestamptz NOT NULL,
  max_uses       integer NOT NULL DEFAULT 1,
  uses           integer NOT NULL DEFAULT 0,
  key_version    integer NOT NULL,
  qr_value       text NOT NULL,
  status         pass_status NOT NULL DEFAULT 'active',
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_pass_window CHECK (valid_to > valid_from),
  CONSTRAINT ck_pass_uses   CHECK (uses >= 0 AND max_uses >= 1)
);
CREATE INDEX IF NOT EXISTS ix_pass_unit ON visitor_passes (society_id, unit_id);

-- Append-only and conflict-free by construction.
--
-- The id is a CLIENT-generated UUIDv7 with no server default: the guard app creates
-- events while offline and replays them on reconnect, so the primary key *is* the
-- deduplication key. Replaying the same payload ten times inserts one row.
CREATE TABLE IF NOT EXISTS gate_events (
  id                  uuid PRIMARY KEY,
  society_id          uuid NOT NULL REFERENCES societies(id),
  gate_id             uuid,
  unit_id             uuid,
  pass_id             uuid,
  guard_person_id     uuid,
  direction           gate_direction   NOT NULL,
  category            visitor_category NOT NULL,
  visitor_name        varchar(120),
  visitor_phone       varchar(16),
  vehicle_number      varchar(20),
  photo_key           varchar(500),
  -- True when the guard app verified the pass signature with no network at all.
  verified_offline    boolean NOT NULL DEFAULT false,
  -- Guard device clocks are routinely hours out. Business logic uses server_ts only;
  -- device_ts is kept so the audit trail can show both and the drift between them.
  device_ts           timestamptz NOT NULL,
  server_ts           timestamptz NOT NULL DEFAULT now(),
  clock_drift_seconds integer,
  synced_at           timestamptz,
  approval_id         uuid,
  exit_of_event_id    uuid,
  overstay_alerted_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gate_event_unit   ON gate_events (society_id, unit_id, server_ts);
CREATE INDEX IF NOT EXISTS ix_gate_event_recent ON gate_events (society_id, server_ts);

CREATE TABLE IF NOT EXISTS approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid NOT NULL REFERENCES societies(id),
  unit_id          uuid NOT NULL,
  gate_event_id    uuid,
  state            approval_state NOT NULL DEFAULT 'pending',
  requested_at     timestamptz NOT NULL,
  resolved_at      timestamptz,
  resolved_by      uuid,
  resolution_rung  approval_rung,
  visitor_name     varchar(120),
  visitor_phone    varchar(16),
  category         visitor_category NOT NULL,
  photo_key        varchar(500),
  standing_rule_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_approval_pending
  ON approvals (society_id, state, requested_at);

-- One row per ladder step fired. This is what lets a resident who says "I never got
-- the notification" be answered with evidence rather than an apology.
CREATE TABLE IF NOT EXISTS approval_rungs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id),
  approval_id    uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  rung           approval_rung NOT NULL,
  fired_at       timestamptz NOT NULL,
  channel_result varchar(200),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_rung_approval ON approval_rungs (society_id, approval_id);

-- Per-unit default applied at the 45-second rung: "always let Amazon in", "never
-- salespeople". This is the answer to the #1 complaint against the incumbents —
-- the unanswered call is a designed path, not an edge case.
CREATE TABLE IF NOT EXISTS standing_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  unit_id    uuid NOT NULL,
  category   visitor_category,
  matcher    varchar(120),
  action     standing_action NOT NULL,
  created_by uuid,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_standing_rule_unit ON standing_rules (society_id, unit_id);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      uuid NOT NULL REFERENCES societies(id),
  person_id       uuid NOT NULL,
  unit_id         uuid,
  type            sos_type NOT NULL,
  latitude        varchar(24),
  longitude       varchar(24),
  raised_at       timestamptz NOT NULL,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  closed_at       timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_sos_open ON sos_alerts (society_id, closed_at);

CREATE TABLE IF NOT EXISTS watchlist (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  phone      varchar(16) NOT NULL,
  name       varchar(120),
  reason     varchar(300) NOT NULL,
  added_by   uuid,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_society_phone
  ON watchlist (society_id, phone);

-- ==========================================================================
-- Ledger
-- ==========================================================================

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id),
  code          varchar(24)  NOT NULL,
  name          varchar(160) NOT NULL,
  type          account_type NOT NULL,
  parent_id     uuid REFERENCES ledger_accounts(id),
  -- Corpus and sinking funds: spending needs committee approval, so the restriction
  -- is a property of the account rather than a convention in someone's head.
  is_restricted boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_society_code
  ON ledger_accounts (society_id, code);

CREATE TABLE IF NOT EXISTS accounting_periods (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id           uuid NOT NULL REFERENCES societies(id),
  starts_on            date NOT NULL,
  ends_on              date NOT NULL,
  status               period_status NOT NULL DEFAULT 'open',
  locked_by            uuid,
  locked_at            timestamptz,
  -- Two-person control: reopening a closed book is how fraud happens, so it takes
  -- two named people and leaves both names behind.
  reopened_by          uuid,
  reopened_approved_by uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_period_range CHECK (ends_on >= starts_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_period_society_start
  ON accounting_periods (society_id, starts_on);

CREATE TABLE IF NOT EXISTS journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        uuid NOT NULL REFERENCES societies(id),
  entry_number      varchar(24) NOT NULL,
  entry_date        date NOT NULL,
  narration         text NOT NULL,
  source_type       journal_source_type NOT NULL,
  source_id         uuid,
  posted_at         timestamptz NOT NULL,
  posted_by         uuid,
  reverses_entry_id uuid REFERENCES journal_entries(id),
  period_id         uuid REFERENCES accounting_periods(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_society_number
  ON journal_entries (society_id, entry_number);
CREATE INDEX IF NOT EXISTS ix_journal_date   ON journal_entries (society_id, entry_date);
CREATE INDEX IF NOT EXISTS ix_journal_source
  ON journal_entries (society_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid NOT NULL REFERENCES societies(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  account_id       uuid NOT NULL REFERENCES ledger_accounts(id),
  debit            numeric(18,4) NOT NULL DEFAULT 0,
  credit           numeric(18,4) NOT NULL DEFAULT 0,
  currency         char(3) NOT NULL DEFAULT 'INR',
  unit_id          uuid
);
CREATE INDEX IF NOT EXISTS ix_line_entry   ON journal_lines (journal_entry_id);
CREATE INDEX IF NOT EXISTS ix_line_account ON journal_lines (society_id, account_id);

-- ==========================================================================
-- Billing
-- ==========================================================================

CREATE TABLE IF NOT EXISTS charge_types (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      uuid NOT NULL REFERENCES societies(id),
  code            varchar(32)  NOT NULL,
  name            varchar(160) NOT NULL,
  formula         billing_formula NOT NULL,
  rate            numeric(18,4) NOT NULL DEFAULT 0,
  account_id      uuid NOT NULL,
  gst_applicable  boolean NOT NULL DEFAULT false,
  gst_rate        numeric(5,2) NOT NULL DEFAULT 18,
  is_recurring    boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_charge_society_code
  ON charge_types (society_id, code);

-- Statutory thresholds as DATA, not code. GST on maintenance needs BOTH the per-member
-- monthly threshold AND the society turnover threshold to be exceeded, and both numbers
-- have moved before and will move again. Hardcoding them means a code deploy per budget.
CREATE TABLE IF NOT EXISTS gst_rules (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id                   uuid NOT NULL REFERENCES societies(id),
  effective_from               date NOT NULL,
  monthly_threshold_per_member numeric(18,4) NOT NULL DEFAULT 7500,
  annual_turnover_threshold    numeric(18,4) NOT NULL DEFAULT 2000000,
  rate                         numeric(5,2)  NOT NULL DEFAULT 18,
  society_turnover             numeric(18,4) NOT NULL DEFAULT 0,
  late_fee_percent_per_month   numeric(5,2)  NOT NULL DEFAULT 0,
  grace_days                   integer NOT NULL DEFAULT 0,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_gst_rules_society ON gst_rules (society_id, effective_from);

CREATE TABLE IF NOT EXISTS invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        uuid NOT NULL REFERENCES societies(id),
  unit_id           uuid NOT NULL,
  invoice_number    varchar(32) NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  issue_date        date NOT NULL,
  due_date          date NOT NULL,
  subtotal          numeric(18,4) NOT NULL DEFAULT 0,
  gst_amount        numeric(18,4) NOT NULL DEFAULT 0,
  late_fee          numeric(18,4) NOT NULL DEFAULT 0,
  total             numeric(18,4) NOT NULL DEFAULT 0,
  currency          char(3) NOT NULL DEFAULT 'INR',
  status            invoice_status NOT NULL DEFAULT 'draft',
  -- Frozen at issue time. If the tenant moves out next week, this invoice is still
  -- theirs — that is the whole point of recording liability rather than deriving it.
  liable_person_id  uuid,
  journal_entry_id  uuid REFERENCES journal_entries(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_invoice_period CHECK (period_end >= period_start),
  CONSTRAINT ck_invoice_amounts CHECK (subtotal >= 0 AND gst_amount >= 0 AND late_fee >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_society_number
  ON invoices (society_id, invoice_number);
CREATE INDEX IF NOT EXISTS ix_invoice_unit_status ON invoices (society_id, unit_id, status);
CREATE INDEX IF NOT EXISTS ix_invoice_due         ON invoices (society_id, due_date);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id),
  invoice_id     uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  charge_type_id uuid NOT NULL,
  description    varchar(300) NOT NULL,
  quantity       numeric(18,4) NOT NULL DEFAULT 1,
  rate           numeric(18,4) NOT NULL DEFAULT 0,
  amount         numeric(18,4) NOT NULL DEFAULT 0,
  gst_rate       numeric(5,2)  NOT NULL DEFAULT 0,
  gst_amount     numeric(18,4) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_invoice_line_invoice ON invoice_lines (invoice_id);

-- ==========================================================================
-- Payments
-- ==========================================================================

-- Where money for a charge goes.
--
--   route_linked    — Razorpay Route, settling to the society's own bank account.
--   direct_merchant — the flat owner's own gateway account, zero platform commission.
--
-- In BOTH modes funds never enter a WatchMyGate account. That is not a preference, it
-- is what keeps the company out of the RBI Payment Aggregator licensing regime.
--
-- Credentials here are REFERENCES to Secret Manager paths, never the secrets.
CREATE TABLE IF NOT EXISTS payment_destinations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id             uuid NOT NULL REFERENCES societies(id),
  payee_type             payee_type NOT NULL,
  payee_id               uuid NOT NULL,
  mode                   destination_mode NOT NULL,
  provider               varchar(32) NOT NULL DEFAULT 'razorpay',
  merchant_id            varchar(120),
  credentials_secret_ref varchar(300),
  webhook_secret_ref     varchar(300),
  status                 destination_status NOT NULL DEFAULT 'pending',
  verified_at            timestamptz,
  -- Razorpay Smart Collect per-unit virtual account, for NEFT/IMPS auto-reconciliation.
  virtual_account_number varchar(64),
  virtual_ifsc           varchar(16),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_destination_payee
  ON payment_destinations (society_id, payee_type, payee_id);

CREATE TABLE IF NOT EXISTS charge_type_routing (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid NOT NULL REFERENCES societies(id),
  charge_type_code varchar(32) NOT NULL,
  unit_id          uuid,
  destination_id   uuid NOT NULL REFERENCES payment_destinations(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_routing
  ON charge_type_routing (society_id, charge_type_code, unit_id);

CREATE TABLE IF NOT EXISTS receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id          uuid NOT NULL REFERENCES societies(id),
  unit_id             uuid,
  receipt_number      varchar(32) NOT NULL,
  received_on         date NOT NULL,
  amount              numeric(18,4) NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'INR',
  method              payment_method NOT NULL,
  provider_payment_id varchar(120),
  -- Webhook idempotency. Razorpay retries aggressively, so the unique violation on a
  -- replay is the correct outcome rather than an error to work around. Unique GLOBALLY,
  -- not per society: a provider event id is unique in the provider's namespace.
  provider_event_id   varchar(160) UNIQUE,
  destination_id      uuid REFERENCES payment_destinations(id),
  journal_entry_id    uuid REFERENCES journal_entries(id),
  payer_person_id     uuid,
  -- Manual UTR entry by a resident. Never marks an invoice paid on its own — it is a
  -- claim awaiting bank confirmation, and conflating the two is how books go wrong.
  unverified_utr      varchar(40),
  verified_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_receipt_amount CHECK (amount > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipt_society_number
  ON receipts (society_id, receipt_number);
CREATE INDEX IF NOT EXISTS ix_receipt_unit ON receipts (society_id, unit_id);

CREATE TABLE IF NOT EXISTS receipt_allocations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  receipt_id uuid NOT NULL REFERENCES receipts(id),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount     numeric(18,4) NOT NULL,
  CONSTRAINT ck_allocation_amount CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS ix_allocation_receipt ON receipt_allocations (receipt_id);
CREATE INDEX IF NOT EXISTS ix_allocation_invoice ON receipt_allocations (invoice_id);

-- ==========================================================================
-- Compliance and delivery
-- ==========================================================================

-- Consent ledger — append-only. Withdrawal is a NEW ROW, never an update, because
-- DPDP requires proving what was consented to and when, not just the current state.
--
-- society_id is nullable (consent can precede joining a society) which is why this
-- table gets no RLS policy — a NULL society_id can never match the policy and the row
-- would become invisible to its own owner. Access is controlled in the service layer.
CREATE TABLE IF NOT EXISTS consents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid REFERENCES societies(id),
  person_id        uuid NOT NULL REFERENCES persons(id),
  purpose          varchar(120) NOT NULL,
  notice_version   varchar(32)  NOT NULL,
  notice_text_hash varchar(64)  NOT NULL,
  granted          boolean NOT NULL,
  granted_at       timestamptz,
  withdrawn_at     timestamptz,
  source           varchar(16) NOT NULL DEFAULT 'app',
  -- inet, matching every other IP column. It validates on write, so a malformed
  -- address is rejected at the boundary rather than discovered during an audit.
  ip               inet,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_consent_person ON consents (person_id, purpose, created_at);

-- Push registrations. Not tenant-scoped: a device belongs to a person, and one person
-- may hold roles in several societies from the same handset.
CREATE TABLE IF NOT EXISTS device_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  token        varchar(400) NOT NULL UNIQUE,
  platform     varchar(16)  NOT NULL,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_device_person ON device_tokens (person_id);

-- ==========================================================================
-- Amenities — booking conflict prevention
-- ==========================================================================
-- An application-level "is this slot free?" check races under concurrency and
-- eventually loses. An exclusion constraint is what actually stops two families
-- booking the party hall for the same evening.
CREATE TABLE IF NOT EXISTS amenities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id   uuid NOT NULL REFERENCES societies(id),
  name         varchar(120) NOT NULL,
  capacity     integer,
  slot_minutes integer NOT NULL DEFAULT 60,
  is_paid      boolean NOT NULL DEFAULT false,
  rate         numeric(18,4) NOT NULL DEFAULT 0,
  rules        jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_amenity_society_name ON amenities (society_id, name);

CREATE TABLE IF NOT EXISTS amenity_bookings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  amenity_id uuid NOT NULL REFERENCES amenities(id),
  unit_id    uuid NOT NULL,
  booked_by  uuid NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  status     varchar(16) NOT NULL DEFAULT 'confirmed',
  invoice_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_booking_range CHECK (ends_at > starts_at),
  CONSTRAINT ex_amenity_no_overlap EXCLUDE USING gist (
    amenity_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status = 'confirmed')
);
CREATE INDEX IF NOT EXISTS ix_booking_amenity ON amenity_bookings (society_id, amenity_id, starts_at);
