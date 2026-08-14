-- Phase 1 controls: RLS policies, ledger immutability, grants.
--
-- Tables and enums are created in 0002. This migration exists separately because it is
-- the part that cannot be expressed in a schema definition and must not be generated:
-- the isolation policies, and database-level enforcement of ledger immutability.
--
-- Order matters. Tables first (0002), controls on top (here) — a policy on a table that
-- does not exist yet is the failure this split was created to fix.

-- ------------------------------------------------ ledger immutability
--
-- Posted journal entries are never edited. Corrections are reversing entries.
--
-- This is enforced twice on purpose: the grant stops the application role, and the
-- trigger stops anyone reaching the table another way (a migration, a console, a
-- future service). Application discipline is not a control — a control is something
-- that holds when the application is wrong.

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Posted ledger entries are immutable. Post a reversing entry instead of altering %.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journal_entries_immutable ON journal_entries;
CREATE TRIGGER trg_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

DROP TRIGGER IF EXISTS trg_journal_lines_immutable ON journal_lines;
CREATE TRIGGER trg_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

REVOKE UPDATE, DELETE ON journal_entries FROM watchmygate_app;
REVOKE UPDATE, DELETE ON journal_lines   FROM watchmygate_app;
GRANT  INSERT, SELECT  ON journal_entries TO watchmygate_app;
GRANT  INSERT, SELECT  ON journal_lines   TO watchmygate_app;

-- ------------------------------------------------------- line integrity
-- Exactly one side per line. Prevents the classic "both zero" or "both set" row that
-- silently unbalances a report months later.
ALTER TABLE journal_lines
  DROP CONSTRAINT IF EXISTS ck_line_non_negative,
  DROP CONSTRAINT IF EXISTS ck_line_one_sided;
ALTER TABLE journal_lines
  ADD CONSTRAINT ck_line_non_negative CHECK (debit >= 0 AND credit >= 0),
  ADD CONSTRAINT ck_line_one_sided    CHECK ((debit = 0) <> (credit = 0));

-- Ratings are 1..5 or absent.
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS ck_ticket_rating;
ALTER TABLE tickets
  ADD CONSTRAINT ck_ticket_rating CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5));

-- ---------------------------------------------------- Row-Level Security
-- Same pattern and the same nullif() reasoning as migration 0001.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ticket_categories', 'tickets', 'ticket_events', 'ticket_subscribers', 'attachments',
    'society_signing_keys', 'gates', 'visitor_passes', 'gate_events', 'approvals',
    'approval_rungs', 'standing_rules', 'sos_alerts', 'watchlist',
    'ledger_accounts', 'accounting_periods', 'journal_entries', 'journal_lines',
    'charge_types', 'gst_rules', 'invoices', 'invoice_lines',
    'payment_destinations', 'charge_type_routing', 'receipts', 'receipt_allocations'
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

-- ------------------------------------------- amenity isolation
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['amenities', 'amenity_bookings'] LOOP
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

GRANT SELECT, INSERT, UPDATE, DELETE ON amenities, amenity_bookings TO watchmygate_app;
