-- Phase 2 tables: staff, attendance, deliveries, notices, polls, vehicles, parking.
--
-- Same split as Phase 1 — tables here, controls in 0008. A policy on a table that does
-- not exist yet is the failure that split was created to fix.
--
-- Several of these carry a design decision that is not obvious from the column list, so
-- each block says what it is protecting against.

-- ==========================================================================
-- Enums
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE staff_kind AS ENUM (
    'maid', 'cook', 'nanny', 'driver', 'gardener', 'security',
    'vendor_staff', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE staff_status AS ENUM ('pending', 'active', 'suspended', 'exited');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Deliberately records only the *outcome* of a verification, never the document.
DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM (
    'not_started', 'submitted', 'verified', 'rejected', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE attendance_method AS ENUM ('gate_scan', 'pin', 'card', 'manual', 'biometric');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM (
    'at_gate', 'awaiting_resident', 'held_at_gate', 'out_for_doorstep',
    'delivered', 'collected', 'returned', 'refused'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notice_kind AS ENUM ('circular', 'event', 'poll', 'emergency');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notice_audience AS ENUM (
    'society', 'tower', 'owners', 'tenants', 'committee', 'custom'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TRAI/DLT: the category a template is *registered* under decides whether it may reach
-- a number on the DND registry. It is a property of the template, not a send-time flag.
DO $$ BEGIN
  CREATE TYPE dlt_category AS ENUM (
    'transactional', 'service_explicit', 'service_implicit', 'promotional'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE vehicle_kind AS ENUM (
    'car', 'two_wheeler', 'bicycle', 'commercial', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE parking_kind AS ENUM (
    'covered', 'open', 'stack', 'visitor', 'accessible', 'ev'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ==========================================================================
-- Staff
-- ==========================================================================
--
-- Aadhaar is never stored. The Aadhaar Act §57 was struck down, so a private entity
-- cannot mandate Aadhaar authentication; verification runs through DigiLocker or offline
-- XML and only the *result* plus a masked last-4 is kept. There is deliberately no
-- column here that could hold a full number.
CREATE TABLE IF NOT EXISTS staff (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id          uuid NOT NULL REFERENCES societies(id),
  person_id           uuid,
  full_name           varchar(160) NOT NULL,
  phone               varchar(16) NOT NULL,
  kind                staff_kind NOT NULL,
  status              staff_status NOT NULL DEFAULT 'pending',
  photo_key           varchar(400),
  employer_unit_id    uuid,
  vendor_name         varchar(160),
  -- Result only. Never the document, never the number.
  verification        verification_status NOT NULL DEFAULT 'not_started',
  verification_ref    varchar(120),
  verified_at         timestamptz,
  id_last4            varchar(4),
  police_verified_at  timestamptz,
  -- A short numeric code the staff member can key in at the gate. This is the
  -- non-biometric alternative that must always exist — see the note on attendance.
  gate_pin_hash       varchar(200),
  daily_start         time,
  daily_end           time,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_staff_id_last4 CHECK (id_last4 IS NULL OR id_last4 ~ '^[0-9]{4}$')
);
CREATE INDEX IF NOT EXISTS ix_staff_society ON staff (society_id, status);
CREATE INDEX IF NOT EXISTS ix_staff_phone ON staff (society_id, phone);
CREATE INDEX IF NOT EXISTS ix_staff_employer ON staff (society_id, employer_unit_id);

-- Which flats a staff member serves. A maid working six flats is the normal case, and
-- modelling it as a single employer_unit_id is the mistake that makes payroll and
-- check-in notifications wrong from day one.
CREATE TABLE IF NOT EXISTS staff_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  unit_id    uuid NOT NULL,
  started_on date NOT NULL DEFAULT current_date,
  ended_on   date,
  monthly_rate numeric(18,4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assignment_range CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_assignment_open
  ON staff_assignments (staff_id, unit_id) WHERE ended_on IS NULL;
CREATE INDEX IF NOT EXISTS ix_assignment_unit ON staff_assignments (society_id, unit_id);

-- Attendance.
--
-- `method` records how the person was identified. Biometric is one option among several
-- and never the only one: a domestic worker cannot meaningfully refuse an employer's
-- demand for a fingerprint, so a PIN or card path must always be available. That is a
-- DPDP "significant harm" exposure, not a preference.
--
-- Timestamps are server-assigned. A gate handset's clock is routinely hours out, and
-- payroll computed from a wrong clock is a wage dispute.
CREATE TABLE IF NOT EXISTS staff_attendance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id),
  staff_id      uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  gate_id       uuid,
  work_date     date NOT NULL,
  checked_in_at timestamptz NOT NULL,
  checked_out_at timestamptz,
  method        attendance_method NOT NULL,
  -- Set only when someone edits attendance after the fact. Payroll is money, so an
  -- override must never be indistinguishable from a real scan.
  overridden_by uuid,
  override_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_attendance_range CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at),
  CONSTRAINT ck_attendance_override CHECK (
    (overridden_by IS NULL AND override_note IS NULL) OR overridden_by IS NOT NULL
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_attendance_open
  ON staff_attendance (staff_id, work_date) WHERE checked_out_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_attendance_day ON staff_attendance (society_id, work_date);

-- ==========================================================================
-- Deliveries
-- ==========================================================================
--
-- Tracked gate-to-doorstep. `handover_*` is the proof half: who took it, when, and the
-- photo or signature. Without that a "delivered" row is only an assertion, which is
-- exactly what residents dispute.
CREATE TABLE IF NOT EXISTS deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid NOT NULL REFERENCES societies(id),
  unit_id          uuid,
  gate_event_id    uuid,
  courier          varchar(120) NOT NULL,
  tracking_ref     varchar(120),
  parcel_count     integer NOT NULL DEFAULT 1,
  status           delivery_status NOT NULL DEFAULT 'at_gate',
  arrived_at       timestamptz NOT NULL DEFAULT now(),
  -- Set when the resident asks the guard to hold it rather than send it up.
  held_at_gate_at  timestamptz,
  handover_at      timestamptz,
  handover_to      varchar(160),
  handover_photo_key varchar(400),
  handover_by      uuid,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_delivery_parcels CHECK (parcel_count > 0)
);
CREATE INDEX IF NOT EXISTS ix_delivery_unit ON deliveries (society_id, unit_id, status);
CREATE INDEX IF NOT EXISTS ix_delivery_open ON deliveries (society_id, status, arrived_at);

-- ==========================================================================
-- Notices, polls
-- ==========================================================================

CREATE TABLE IF NOT EXISTS notices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id),
  kind          notice_kind NOT NULL DEFAULT 'circular',
  title         varchar(200) NOT NULL,
  body          text NOT NULL,
  audience      notice_audience NOT NULL DEFAULT 'society',
  -- Tower ids / unit ids when audience is 'tower' or 'custom'.
  audience_ref  jsonb,
  is_pinned     boolean NOT NULL DEFAULT false,
  publish_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  event_at      timestamptz,
  event_place   varchar(200),
  created_by    uuid NOT NULL,
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_notice_expiry CHECK (expires_at IS NULL OR expires_at > publish_at)
);
CREATE INDEX IF NOT EXISTS ix_notice_feed ON notices (society_id, publish_at DESC);

-- Read receipts. A committee's commonest question about a circular is "did anyone
-- actually see this", and without this table the answer is a guess.
CREATE TABLE IF NOT EXISTS notice_reads (
  notice_id  uuid NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL,
  society_id uuid NOT NULL REFERENCES societies(id),
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, person_id)
);

CREATE TABLE IF NOT EXISTS poll_options (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id),
  notice_id  uuid NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  label      varchar(200) NOT NULL,
  position   integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_poll_option_notice ON poll_options (notice_id, position);

-- One vote per person per poll, enforced by the primary key rather than by application
-- discipline — a poll a committee acts on has to be countable without argument.
CREATE TABLE IF NOT EXISTS poll_votes (
  notice_id  uuid NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL,
  society_id uuid NOT NULL REFERENCES societies(id),
  option_id  uuid NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  voted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notice_id, person_id)
);
CREATE INDEX IF NOT EXISTS ix_poll_vote_option ON poll_votes (option_id);

-- ==========================================================================
-- DLT template registry
-- ==========================================================================
--
-- Every commercial SMS in India needs a DLT-registered header and template, and the
-- registered *category* decides whether it may reach a DND number. Holding that as a
-- row here — rather than as a constant in the sending code — is what lets the notify
-- service refuse a promotional send to a DND number without a human remembering to.
CREATE TABLE IF NOT EXISTS dlt_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid REFERENCES societies(id),
  code          varchar(80) NOT NULL,
  provider_id   varchar(120) NOT NULL,
  header        varchar(20) NOT NULL,
  category      dlt_category NOT NULL,
  body          text NOT NULL,
  variables     jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  registered_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Platform-wide templates carry society_id IS NULL; a society may override by code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dlt_code_society
  ON dlt_templates (code, COALESCE(society_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ==========================================================================
-- Vehicles and parking
-- ==========================================================================
--
-- Plates are stored normalised (uppercase, no spaces or hyphens) because the same car
-- is written "KA05MJ9876", "KA 05 MJ 9876" and "ka-05-mj-9876" by three different
-- guards, and a lookup that misses is a resident stopped at their own gate.
CREATE TABLE IF NOT EXISTS vehicles (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid NOT NULL REFERENCES societies(id),
  unit_id        uuid,
  staff_id       uuid REFERENCES staff(id) ON DELETE SET NULL,
  plate          varchar(16) NOT NULL,
  plate_display  varchar(24) NOT NULL,
  kind           vehicle_kind NOT NULL DEFAULT 'car',
  make_model     varchar(120),
  colour         varchar(40),
  sticker_no     varchar(40),
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_vehicle_plate_normalised CHECK (plate = upper(plate) AND plate !~ '[^A-Z0-9]')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicle_plate ON vehicles (society_id, plate) WHERE is_active;
CREATE INDEX IF NOT EXISTS ix_vehicle_unit ON vehicles (society_id, unit_id);

CREATE TABLE IF NOT EXISTS parking_slots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id  uuid NOT NULL REFERENCES societies(id),
  code        varchar(40) NOT NULL,
  kind        parking_kind NOT NULL DEFAULT 'open',
  tower_id    uuid,
  level       varchar(20),
  -- Allotment lives on the slot: a slot has at most one holder at a time, so a separate
  -- allotment table would allow two rows to claim it. The unique index below is the
  -- control that actually prevents double-allotment.
  unit_id     uuid,
  vehicle_id  uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  allotted_at timestamptz,
  monthly_rate numeric(18,4) NOT NULL DEFAULT 0,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_code ON parking_slots (society_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_vehicle
  ON parking_slots (society_id, vehicle_id) WHERE vehicle_id IS NOT NULL;

-- Unauthorised parking, flagged by a guard or by plate recognition.
CREATE TABLE IF NOT EXISTS parking_violations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id  uuid NOT NULL REFERENCES societies(id),
  slot_id     uuid REFERENCES parking_slots(id) ON DELETE SET NULL,
  vehicle_id  uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  plate       varchar(16) NOT NULL,
  reason      varchar(120) NOT NULL,
  photo_key   varchar(400),
  reported_by uuid,
  reported_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_violation_open ON parking_violations (society_id, resolved_at);
