-- Foundation: schema, application role, Row-Level Security, immutable audit log.
--
-- This SQL was written and verified against a real Postgres before the stack moved to
-- TypeScript. It is carried over unchanged because SQL is language-agnostic and this
-- is the part of the system that must not be re-derived: it is the isolation guarantee
-- the whole platform rests on.
--
--   * An application role created NOBYPASSRLS and without table ownership, so it is
--     structurally incapable of reading across societies even if application code is
--     wrong.
--   * ENABLE + FORCE ROW LEVEL SECURITY on every tenant table, so policies apply to
--     the owner too.
--   * nullif(current_setting(...), '') — load-bearing, see the note at the policy.
--   * INSERT-only grants on audit_log, so a compromised application cannot rewrite
--     history.

-- ---------------------------------------------------------------- extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- --------------------------------------------------------------------- enums
DO $$ BEGIN
  CREATE TYPE society_status AS ENUM ('onboarding', 'active', 'suspended');
  CREATE TYPE plan_tier AS ENUM ('basic', 'pro', 'enterprise');
  CREATE TYPE unit_status AS ENUM ('occupied', 'vacant', 'under_renovation');
  CREATE TYPE occupancy_relationship AS ENUM ('owner', 'tenant', 'family_member', 'occupant');
  CREATE TYPE person_status AS ENUM ('active', 'deactivated');
  CREATE TYPE role_code AS ENUM (
    'super_admin', 'society_admin', 'mc_member', 'accountant',
    'auditor', 'guard', 'resident', 'staff'
  );
  CREATE TYPE role_scope_type AS ENUM ('society', 'tower', 'unit');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------- societies
CREATE TABLE IF NOT EXISTS societies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        varchar(200) NOT NULL,
  slug        varchar(80)  NOT NULL UNIQUE,
  -- Drives the statutory rule-pack: billing heads and AGM rules differ by state.
  state_code  char(2)      NOT NULL,
  plan_tier   plan_tier    NOT NULL DEFAULT 'basic',
  timezone    varchar(64)  NOT NULL DEFAULT 'Asia/Kolkata',
  status      society_status NOT NULL DEFAULT 'onboarding',
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------- people
-- Deliberately NOT tenant-scoped: one human may be a resident in society A and a
-- committee member in society B. Scoping lives on the relationship, not the person.
CREATE TABLE IF NOT EXISTS persons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         varchar(16) NOT NULL UNIQUE,   -- E.164, the login identity
  name          varchar(200),
  email         varchar(320),
  status        person_status NOT NULL DEFAULT 'active',
  totp_enrolled boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code role_code   NOT NULL UNIQUE,
  name varchar(80) NOT NULL
);

-- The OTP code itself is never stored, only an Argon2 hash, so a database disclosure
-- does not hand an attacker live login codes.
CREATE TABLE IF NOT EXISTS otp_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       varchar(16)  NOT NULL,
  code_hash   varchar(255) NOT NULL,
  expires_at  timestamptz  NOT NULL,
  attempts    integer      NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  request_ip  inet,
  created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_otp_phone_active ON otp_challenges (phone, expires_at);

-- Refresh tokens rotate on every use. rotated_to detects reuse of an already-exchanged
-- token, which means a copy leaked — the whole session family is then revoked.
CREATE TABLE IF NOT EXISTS sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id          uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  refresh_token_hash varchar(255) NOT NULL UNIQUE,
  device_id          varchar(128),
  device_label       varchar(128),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  rotated_to         uuid,
  last_used_at       timestamptz,
  ip                 inet,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_session_person_active
  ON sessions (person_id) WHERE revoked_at IS NULL;

-- ------------------------------------------------------- tenant-scoped tables
CREATE TABLE IF NOT EXISTS towers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  name       varchar(80) NOT NULL,
  floors     integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (society_id, name)
);
CREATE INDEX IF NOT EXISTS ix_towers_society ON towers (society_id);

CREATE TABLE IF NOT EXISTS units (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id       uuid NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  tower_id         uuid NOT NULL REFERENCES towers(id) ON DELETE RESTRICT,
  number           varchar(32) NOT NULL,
  floor            integer,
  carpet_area_sqft numeric(10,2),
  bhk              integer,
  status           unit_status NOT NULL DEFAULT 'vacant',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (society_id, tower_id, number)
);
CREATE INDEX IF NOT EXISTS ix_units_society ON units (society_id);
CREATE INDEX IF NOT EXISTS ix_units_society_status ON units (society_id, status);

-- Bitemporal. valid_from/valid_to is business time (when they actually lived there);
-- recorded_at is system time (when we learned it). A resident saying six weeks later
-- "I actually moved out on the 3rd" inserts a correction rather than editing history,
-- so bills regenerate correctly and the audit trail keeps what we believed and when.
--
-- Billing liability, voting rights and app access are THREE separate relationships:
-- the owner may vote while the tenant pays, and both need access. Collapsing them into
-- one "resident" field is the classic bug in this category.
CREATE TABLE IF NOT EXISTS unit_occupancies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id        uuid NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  unit_id           uuid NOT NULL REFERENCES units(id)     ON DELETE RESTRICT,
  person_id         uuid NOT NULL REFERENCES persons(id)   ON DELETE RESTRICT,
  relationship      occupancy_relationship NOT NULL,
  is_billing_liable boolean NOT NULL DEFAULT false,
  has_voting_right  boolean NOT NULL DEFAULT false,
  has_app_access    boolean NOT NULL DEFAULT true,
  valid_from        date NOT NULL,
  valid_to          date,
  superseded_at     timestamptz,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_occupancy_valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX IF NOT EXISTS ix_occupancy_society ON unit_occupancies (society_id);
CREATE INDEX IF NOT EXISTS ix_occupancy_person  ON unit_occupancies (society_id, person_id);
CREATE INDEX IF NOT EXISTS ix_occupancy_current ON unit_occupancies (society_id, unit_id)
  WHERE valid_to IS NULL AND superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS role_assignments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES societies(id) ON DELETE RESTRICT,
  person_id  uuid NOT NULL REFERENCES persons(id)   ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id)     ON DELETE RESTRICT,
  scope_type role_scope_type NOT NULL DEFAULT 'society',
  scope_id   uuid,
  valid_from date NOT NULL,
  valid_to   date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_role_assignment_society ON role_assignments (society_id);
CREATE INDEX IF NOT EXISTS ix_role_assignment_person  ON role_assignments (person_id, society_id);
CREATE INDEX IF NOT EXISTS ix_role_assignment_active  ON role_assignments (society_id, person_id)
  WHERE valid_to IS NULL;

-- ------------------------------------------------- audit log (partitioned)
CREATE TABLE IF NOT EXISTS audit_log (
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  society_id      uuid,
  actor_person_id uuid,
  action          varchar(80) NOT NULL,
  entity_type     varchar(80) NOT NULL,
  entity_id       uuid,
  before          jsonb,
  after           jsonb,
  reason          varchar(500),   -- required for sensitive reads (credentials, CCTV)
  ip              inet,
  user_agent      varchar(400),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX IF NOT EXISTS ix_audit_society_created ON audit_log (society_id, created_at);
CREATE INDEX IF NOT EXISTS ix_audit_entity          ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_actor           ON audit_log (actor_person_id, created_at);

-- Rolling monthly partitions covering the current window, so a fresh database is
-- immediately writable. The worker creates future months ahead of time.
DO $$
DECLARE
  start_month date := date_trunc('month', now())::date - interval '1 month';
  i int; part_start date; part_end date;
BEGIN
  FOR i IN 0..12 LOOP
    part_start := (start_month + (i || ' month')::interval)::date;
    part_end   := (start_month + ((i + 1) || ' month')::interval)::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS audit_log_%s PARTITION OF audit_log
         FOR VALUES FROM (%L) TO (%L)',
      to_char(part_start, 'YYYY_MM'), part_start, part_end
    );
  END LOOP;
END $$;

-- --------------------------------------------------------- application role
-- NOBYPASSRLS and no table ownership: structurally unable to cross tenants.
--
-- Created NOLOGIN and with NO PASSWORD on purpose. A password does not belong in a
-- committed migration, not even a placeholder one — placeholders get run as-is and
-- become real credentials. `migrate.ts` grants LOGIN and sets the password from
-- APP_DB_PASSWORD afterwards, so the secret only ever exists in the environment.
--
-- Until that step runs the role exists but cannot connect, which is the safe order.
--
-- On Neon this matters more than on vanilla Postgres: neondb_owner carries BYPASSRLS,
-- which overrides even FORCE ROW LEVEL SECURITY. The owner role can therefore read
-- every society. This separate role is what makes isolation real rather than nominal —
-- pointing DATABASE_URL at the owner would silently void it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'watchmygate_app') THEN
    CREATE ROLE watchmygate_app NOLOGIN NOBYPASSRLS;
  ELSE
    ALTER ROLE watchmygate_app NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO watchmygate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO watchmygate_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO watchmygate_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO watchmygate_app;

-- Audit log is append-only for the application: history cannot be rewritten.
REVOKE UPDATE, DELETE ON audit_log FROM watchmygate_app;
GRANT INSERT, SELECT ON audit_log TO watchmygate_app;

-- ------------------------------------------------------ Row-Level Security
--
-- nullif(current_setting('app.society_id', true), '') is load-bearing, not defensive
-- noise. set_config(..., is_local => true) resets to the EMPTY STRING at transaction
-- end, not to NULL. So on a pooled connection that previously served a scoped request,
-- a bare ''::uuid raises InvalidTextRepresentation instead of filtering — making
-- unscoped behaviour depend on whether the connection happened to be warm.
--
-- nullif() turns both the unset and the reset case into NULL, the comparison into
-- NULL, and the row into a non-match. Unscoped queries therefore return ZERO ROWS,
-- deterministically. It fails closed.
--
-- This was found by running the isolation tests against a real Postgres, not by review.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['towers', 'units', 'unit_occupancies', 'role_assignments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the policy applies to the table owner too; without it an admin or
    -- migration connection would silently see every society.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING      (society_id = nullif(current_setting(''app.society_id'', true), '''')::uuid)
         WITH CHECK (society_id = nullif(current_setting(''app.society_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- --------------------------------------------------------------- seed roles
INSERT INTO roles (id, code, name) VALUES
  (gen_random_uuid(), 'super_admin',   'Platform Super Admin'),
  (gen_random_uuid(), 'society_admin', 'Society Admin'),
  (gen_random_uuid(), 'mc_member',     'Committee Member'),
  (gen_random_uuid(), 'accountant',    'Accountant'),
  (gen_random_uuid(), 'auditor',       'Auditor (read-only)'),
  (gen_random_uuid(), 'guard',         'Security Guard'),
  (gen_random_uuid(), 'resident',      'Resident'),
  (gen_random_uuid(), 'staff',         'Staff / Vendor')
ON CONFLICT (code) DO NOTHING;
