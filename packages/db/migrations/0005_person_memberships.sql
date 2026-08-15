-- "Which societies does this person belong to?" — the one legitimate cross-society read.
--
-- This question has to be answered BEFORE a society is chosen, so it cannot be
-- tenant-scoped: at login we do not yet know which society to scope to. That is the
-- whole point of the query.
--
-- The tempting fixes are both wrong:
--
--   * Granting BYPASSRLS to the application role would void tenant isolation entirely
--     for every other query in the system, to solve one lookup.
--   * Widening the RLS policy on role_assignments would mean every future bug touching
--     that table has a larger blast radius.
--
-- Instead: one SECURITY DEFINER function that answers exactly this question and nothing
-- else. It runs with the definer's rights, so it sees across societies — but it accepts
-- only a person id, returns only that person's own memberships, and its whole surface
-- is the twenty lines below. That is auditable in a way that a policy change is not.
--
-- search_path is pinned. Without it, a SECURITY DEFINER function can be hijacked by a
-- caller who creates a shadowing object in a schema earlier on their own search_path —
-- the classic Postgres privilege-escalation route.

CREATE OR REPLACE FUNCTION person_memberships(p_person_id uuid)
RETURNS TABLE (society_id uuid, society_name text, role_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.id,
         s.name::text,
         r.code::text
    FROM role_assignments ra
    JOIN societies s ON s.id = ra.society_id
    JOIN roles     r ON r.id = ra.role_id
   WHERE ra.person_id  = p_person_id
     AND ra.valid_to   IS NULL
     AND ra.valid_from <= current_date
     AND s.status <> 'suspended';
$$;

-- Callable by the application role, which is the only caller.
REVOKE ALL   ON FUNCTION person_memberships(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION person_memberships(uuid) TO watchmygate_app;

COMMENT ON FUNCTION person_memberships(uuid) IS
  'Cross-society membership lookup for login. SECURITY DEFINER by necessity: the '
  'caller has not chosen a society yet. Returns only the given person''s own '
  'memberships. Do not widen this function — add a new one instead.';
