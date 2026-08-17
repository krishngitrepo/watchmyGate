-- Phase 2 controls: RLS, immutability, grants for the tables created in 0007.
--
-- Same reasoning as 0003. The isolation policy is the single most important control in
-- this product, so every new table gets one in the same pass that creates it — a table
-- that reaches production without a policy is a cross-society data leak.

-- ---------------------------------------------------- Row-Level Security
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'staff', 'staff_assignments', 'staff_attendance',
    'deliveries',
    'notices', 'notice_reads', 'poll_options', 'poll_votes',
    'vehicles', 'parking_slots', 'parking_violations'
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

GRANT SELECT, INSERT, UPDATE, DELETE ON
  staff, staff_assignments, staff_attendance,
  deliveries,
  notices, notice_reads, poll_options, poll_votes,
  vehicles, parking_slots, parking_violations
TO watchmygate_app;

-- ------------------------------------------------------- DLT templates
--
-- Not tenant-scoped the same way: platform templates carry society_id IS NULL and must
-- be readable by every society, so the policy admits those explicitly. Writes stay
-- society-scoped, so one society can never edit a platform template or another
-- society's override.
ALTER TABLE dlt_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE dlt_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON dlt_templates;
CREATE POLICY tenant_isolation ON dlt_templates
  USING (
    society_id IS NULL
    OR society_id = nullif(current_setting('app.society_id', true), '')::uuid
  )
  WITH CHECK (
    society_id = nullif(current_setting('app.society_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON dlt_templates TO watchmygate_app;

-- --------------------------------------------- attendance is a wage record
--
-- Deleting attendance destroys the evidence behind someone's pay. Corrections go
-- through the override columns, which record who changed it and why; the row itself
-- stays. Enforced at the database rather than in the service, for the same reason the
-- ledger is: a control is something that holds when the application is wrong.
CREATE OR REPLACE FUNCTION reject_attendance_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Attendance rows are a wage record and cannot be deleted. Record an override instead.'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_attendance_no_delete ON staff_attendance;
CREATE TRIGGER trg_attendance_no_delete
  BEFORE DELETE ON staff_attendance
  FOR EACH ROW EXECUTE FUNCTION reject_attendance_delete();

REVOKE DELETE ON staff_attendance FROM watchmygate_app;

-- `updated_at` is set by the application on every write, matching Phase 1 — there is no
-- touch trigger in this schema. Worth stating so the absence reads as a convention
-- rather than an oversight.
