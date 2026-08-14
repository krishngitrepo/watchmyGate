-- Align consents.ip with every other IP column in the schema.
--
-- 0002 originally created this as varchar(45) while schema.ts declared inet. The two
-- disagreed, which is precisely the drift `schema-parity.test.ts` was written to catch —
-- and it caught this on its first run.
--
-- 0002 has since been corrected, so a fresh database creates the column as inet and this
-- migration is a no-op there. It exists for databases already migrated past 0002.
--
-- inet is the right type: it validates on write, so a malformed address fails at the
-- boundary instead of surfacing during a DPDP audit years later.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'consents'
       AND column_name  = 'ip'
       AND data_type    = 'character varying'
  ) THEN
    -- USING is required: Postgres has no implicit varchar → inet cast.
    -- nullif('') guards rows that stored an empty string, which inet would reject.
    ALTER TABLE consents
      ALTER COLUMN ip TYPE inet USING nullif(ip, '')::inet;
  END IF;
END $$;
