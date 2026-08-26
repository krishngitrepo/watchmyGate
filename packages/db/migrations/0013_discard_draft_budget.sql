-- Let an abandoned draft budget go.
--
-- Migration 0011 withheld DELETE on `budgets` entirely, with the reasoning that a budget
-- the AGM passed is the record of a decision and superseding is the only correct way to
-- move on from it. That reasoning is right about a *passed* budget and wrong about a
-- draft, and combining it with `uq_budget_year_live` produced a trap:
--
--   A treasurer starts a draft for 2027-28, gets called away, and never finishes it. The
--   unique index allows one live budget per financial year. The draft cannot be deleted.
--   Nobody can ever raise a budget for that year again.
--
-- Found by a test walking forward a year per run to avoid the index, which eventually hit
-- the 2100 ceiling on `ck_budget_year` — a contrived route to a problem a real society
-- reaches the first time somebody abandons a draft.
--
-- So DELETE comes back, and a trigger keeps the half of the original reasoning that was
-- correct: **only a draft can be deleted.** An approved budget is a decision and a
-- superseded one is history, and neither can be removed by any role through ordinary SQL.

CREATE OR REPLACE FUNCTION budget_delete_only_drafts() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION
      'A budget that has been passed cannot be deleted. Supersede it with a revision.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_budget_delete_drafts_only ON budgets;
CREATE TRIGGER trg_budget_delete_drafts_only
  BEFORE DELETE ON budgets
  FOR EACH ROW EXECUTE FUNCTION budget_delete_only_drafts();

GRANT DELETE ON budgets TO watchmygate_app;

-- Note on the cascade: `budget_lines` has ON DELETE CASCADE from `budgets`, and its own
-- freeze trigger refuses any change to the lines of a non-draft budget. Those two agree
-- rather than fight — the only budget whose rows can cascade away is a draft, which is
-- exactly the one whose lines the freeze already permits removing.
