-- Keep `audit_log` writable by creating its partitions ahead of time.
--
-- Migration 0001 seeds a rolling window of monthly partitions. A window runs out. When
-- it does, every audited action — every login, every ledger posting, every gate entry —
-- starts failing at midnight on the 1st, which is a spectacularly bad moment to find
-- out. So a scheduled job tops it up.
--
-- The job cannot do this directly: `watchmygate_app` holds USAGE on schema public but
-- not CREATE, so it cannot make a table. That restriction is deliberate and worth
-- keeping — an application role that can create objects is one SQL injection away from
-- installing a trigger. The wrong fix is GRANT CREATE; the right one is a single
-- function that creates exactly these partitions and nothing else.
--
-- Discovered by running the job, which returned "permission denied for schema public".
-- The permission was right and the design was wrong.

CREATE OR REPLACE FUNCTION ensure_audit_partitions(months_ahead int DEFAULT 3)
RETURNS TABLE (partition_name text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  i int;
  part_start date;
  part_end   date;
  part_name  text;
  existed    boolean;
BEGIN
  -- Bounded so a caller cannot ask for ten thousand partitions and exhaust the catalog.
  IF months_ahead < 1 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'months_ahead must be between 1 and 24, got %', months_ahead;
  END IF;

  FOR i IN 0..months_ahead LOOP
    part_start := (date_trunc('month', now()) + (i || ' month')::interval)::date;
    part_end   := (date_trunc('month', now()) + ((i + 1) || ' month')::interval)::date;
    part_name  := 'audit_log_' || to_char(part_start, 'YYYY_MM');

    SELECT EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = part_name
    ) INTO existed;

    IF NOT existed THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
        part_name, part_start, part_end
      );
      -- The application must be able to append to a partition it did not create.
      EXECUTE format('GRANT INSERT, SELECT ON %I TO watchmygate_app', part_name);
      -- History stays append-only: the same revocation as the parent table in 0001.
      EXECUTE format('REVOKE UPDATE, DELETE ON %I FROM watchmygate_app', part_name);
    END IF;

    partition_name := part_name;
    created := NOT existed;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL    ON FUNCTION ensure_audit_partitions(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_audit_partitions(int) TO watchmygate_app;

COMMENT ON FUNCTION ensure_audit_partitions(int) IS
  'Creates future audit_log partitions. SECURITY DEFINER because the application role '
  'deliberately cannot create tables. Idempotent; bounded to 24 months.';
