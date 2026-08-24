-- DPDP Act 2023 / Rules 2025.
--
-- Rules notified 13 Nov 2025. Consent Manager registration opens 13 Nov 2026. Full
-- substantive compliance is due **13 May 2027**, with penalties to Rs 250 crore. This is
-- dated work with a statutory deadline, not a backlog item that can drift.
--
-- The `consents` table already existed and nothing wrote to it. What was missing is
-- everything that makes it mean something: the notice text a consent refers to, a record
-- of erasure requests and what was actually done, a log of who looked at CCTV and why,
-- and — the part that is easy to promise and hard to prove — controls making the ledger
-- append-only at the database rather than by application discipline.
--
-- The principle throughout: **a consent record that can be edited is not evidence.** If a
-- society can rewrite what someone agreed to, the ledger proves nothing to a regulator
-- and protects nobody.

-- =====================================================================
-- Notice text, versioned
-- =====================================================================
--
-- A consent record points at a notice version and a hash of its text. Without the text
-- itself stored immutably, "they consented to v3" is unfalsifiable — and a society that
-- quietly edits v3 afterwards has rewritten what every one of its residents agreed to.
CREATE TABLE IF NOT EXISTS consent_notices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid REFERENCES societies(id),
  purpose        varchar(120) NOT NULL,
  version        varchar(32)  NOT NULL,
  -- The exact words shown, in the language they were shown in. DPDP requires notice in
  -- English or any of the Eighth Schedule languages at the individual's option.
  language       varchar(8)   NOT NULL DEFAULT 'en',
  body           text         NOT NULL,
  -- sha256 of `body`. `consents.notice_text_hash` must match, which is what ties a
  -- consent to words rather than to a version label someone can redefine.
  body_hash      varchar(64)  NOT NULL,
  effective_from timestamptz  NOT NULL DEFAULT now(),
  retired_at     timestamptz,
  created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_notice_version
  ON consent_notices (COALESCE(society_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      purpose, version, language);

-- =====================================================================
-- Erasure requests — DPDP s.12, the right to erasure
-- =====================================================================
--
-- Modelled as a request with an outcome rather than as an immediate delete, because the
-- honest answer to "erase everything about me" is never simply yes:
--
--   * Financial records are **retained under statutory exemption** — a society must keep
--     its books, and a resident cannot erase an invoice they owe. s.8(7) permits
--     retention where required by law.
--   * Gate events involving other people, audit entries, and the immutable journal are
--     equally not erasable.
--
-- So the request records what was erased, what was retained, and the legal basis for
-- retaining it. A workflow that promised total erasure and quietly kept the ledger would
-- be worse than one that says plainly what it keeps.
CREATE TABLE IF NOT EXISTS erasure_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id     uuid REFERENCES societies(id),
  person_id      uuid NOT NULL REFERENCES persons(id),
  requested_by   uuid REFERENCES persons(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  status         varchar(16) NOT NULL DEFAULT 'received',
  -- DPDP gives the Data Fiduciary a reasonable period; the Rules expect a stated one.
  due_by         timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  completed_at   timestamptz,
  completed_by   uuid REFERENCES persons(id),
  erased         jsonb,
  retained       jsonb,
  retention_basis text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_erasure_status
    CHECK (status IN ('received', 'in_progress', 'completed', 'refused'))
);

CREATE INDEX IF NOT EXISTS ix_erasure_person ON erasure_requests (person_id, requested_at);
CREATE INDEX IF NOT EXISTS ix_erasure_due ON erasure_requests (status, due_by);

-- =====================================================================
-- CCTV access log
-- =====================================================================
--
-- Footage is among the most sensitive things a society holds, and the usual failure is
-- not a breach — it is a committee member idly watching who visits whom. Every access
-- carries a stated reason, and the log is append-only.
--
-- Retention is capped separately: see `retention_policies` below.
CREATE TABLE IF NOT EXISTS cctv_access_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id   uuid NOT NULL REFERENCES societies(id),
  person_id    uuid NOT NULL REFERENCES persons(id),
  camera_ref   varchar(120) NOT NULL,
  from_ts      timestamptz NOT NULL,
  to_ts        timestamptz NOT NULL,
  -- Not optional and not free of consequence: this is what an audit reads.
  reason       text NOT NULL,
  accessed_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_cctv_reason CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT ck_cctv_window CHECK (to_ts > from_ts)
);

CREATE INDEX IF NOT EXISTS ix_cctv_society ON cctv_access_log (society_id, accessed_at);

-- =====================================================================
-- Retention policies
-- =====================================================================
--
-- Purpose limitation with a number attached. Defaults are deliberately conservative and
-- match both DPDP's storage-limitation principle and what competitors publish:
--
--   gate_events  180 days  -- six months, also MG-29
--   cctv         30 days   -- the cap this product commits to
--   attachments  365 days  -- complaint photos outlive the complaint, briefly
--
-- A society may lengthen these only where it can state a purpose; the console shows the
-- default and what it was changed to.
CREATE TABLE IF NOT EXISTS retention_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id  uuid NOT NULL REFERENCES societies(id),
  subject     varchar(40) NOT NULL,
  days        integer NOT NULL,
  reason      text,
  updated_by  uuid REFERENCES persons(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_retention_days CHECK (days BETWEEN 1 AND 3650)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_retention_subject
  ON retention_policies (society_id, subject);

-- Every purge run, so a regulator can be shown that the policy is enforced rather than
-- merely configured. A retention policy nobody runs is a lie with a number in it.
CREATE TABLE IF NOT EXISTS retention_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id   uuid REFERENCES societies(id),
  subject      varchar(40) NOT NULL,
  cutoff       timestamptz NOT NULL,
  rows_removed integer NOT NULL DEFAULT 0,
  ran_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_retention_run ON retention_runs (society_id, ran_at);

-- =====================================================================
-- The controls
-- =====================================================================

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consents;
-- Platform-wide consents carry society_id IS NULL and must be visible to everyone, the
-- same asymmetry `dlt_templates` uses. Writes are always scoped.
CREATE POLICY tenant_isolation ON consents
  USING (
    society_id IS NULL
    OR society_id = nullif(current_setting('app.society_id', true), '')::uuid
  )
  WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'erasure_requests', 'cctv_access_log', 'retention_policies', 'retention_runs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
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

ALTER TABLE consent_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_notices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON consent_notices;
CREATE POLICY tenant_isolation ON consent_notices
  USING (
    society_id IS NULL
    OR society_id = nullif(current_setting('app.society_id', true), '')::uuid
  )
  WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);

-- ------------------------------------------------- append-only ledgers
--
-- The consent ledger and the CCTV access log are evidence. Both are append-only, and
-- both are enforced here rather than in the application, because a control that only
-- holds while the calling code is correct is not a control.
--
-- `consents` permits exactly one UPDATE: setting `withdrawn_at` on a row that has not
-- already been withdrawn. Withdrawal is a right under s.6(6) and has to be recordable;
-- everything else about a consent record is frozen the moment it is written.
CREATE OR REPLACE FUNCTION consents_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Consent records cannot be deleted. They are the evidence that consent was given.';
  END IF;

  IF OLD.withdrawn_at IS NOT NULL THEN
    RAISE EXCEPTION 'This consent was already withdrawn. Withdrawal is recorded once.';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.notice_version IS DISTINCT FROM OLD.notice_version
     OR NEW.notice_text_hash IS DISTINCT FROM OLD.notice_text_hash
     OR NEW.granted IS DISTINCT FROM OLD.granted
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'A consent record cannot be rewritten. Record a withdrawal, or a new consent.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_consents_append_only ON consents;
CREATE TRIGGER trg_consents_append_only
  BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION consents_append_only();

CREATE OR REPLACE FUNCTION cctv_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The CCTV access log cannot be changed or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cctv_append_only ON cctv_access_log;
CREATE TRIGGER trg_cctv_append_only
  BEFORE UPDATE OR DELETE ON cctv_access_log
  FOR EACH ROW EXECUTE FUNCTION cctv_log_append_only();

-- Notice text is immutable once written. Correcting a notice means publishing a new
-- version, which is the only way "they agreed to v3" can be checked later.
CREATE OR REPLACE FUNCTION consent_notices_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notice text cannot be deleted. Retire it instead.';
  END IF;
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.body_hash IS DISTINCT FROM OLD.body_hash THEN
    RAISE EXCEPTION 'Notice text is immutable. Publish a new version.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notice_immutable ON consent_notices;
CREATE TRIGGER trg_notice_immutable
  BEFORE UPDATE OR DELETE ON consent_notices
  FOR EACH ROW EXECUTE FUNCTION consent_notices_immutable();

-- ------------------------------------------------------------- grants
--
-- DELETE is granted on none of the append-only tables. The triggers above would refuse
-- anyway; revoking the privilege as well means the application cannot even attempt it.
GRANT SELECT, INSERT, UPDATE ON consents, consent_notices TO watchmygate_app;
GRANT SELECT, INSERT ON cctv_access_log, retention_runs TO watchmygate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON erasure_requests, retention_policies TO watchmygate_app;

REVOKE DELETE ON consents, consent_notices, cctv_access_log, retention_runs
  FROM watchmygate_app;
