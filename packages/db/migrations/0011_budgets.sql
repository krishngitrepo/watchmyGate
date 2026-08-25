-- Budgets and variance (MG-6).
--
-- A society approves an annual budget at its AGM, head by head, and then spends the year
-- wanting to know one thing: are we inside it. Today that question is answered in a
-- spreadsheet that lives on the treasurer's laptop and leaves with them.
--
-- Two decisions shape this table, and both are about what a budget *is*:
--
--   1. **Actuals are never stored here.** Every actual figure is read from
--      `journal_lines` at query time. A budget table that carries its own copy of what
--      was spent will drift from the ledger, and the moment it does, the committee has
--      two numbers and no way to tell which is the society's.
--
--   2. **An approved budget cannot be edited.** A budget a treasurer can quietly amend
--      after the AGM is not a budget, it is a running commentary. Approval freezes the
--      lines by trigger; a genuine change is a **revision** — a new budget row pointing
--      back at the one it supersedes, which is how the AGM sees that a revision happened
--      at all.
--
-- The financial year is 1 April to 31 March. That is statutory, not a preference, so it
-- is stored as the starting calendar year and derived rather than configured.

CREATE TABLE IF NOT EXISTS budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      uuid NOT NULL REFERENCES societies(id),

  -- 2026 means FY 2026-27: 1 Apr 2026 to 31 Mar 2027.
  financial_year  integer NOT NULL,
  title           varchar(160) NOT NULL,
  notes           text,

  status          varchar(16) NOT NULL DEFAULT 'draft',
  approved_by     uuid REFERENCES persons(id),
  approved_at     timestamptz,
  /** The AGM or committee resolution this was passed under. */
  approved_ref    varchar(160),

  -- A revision points back at what it replaces, so the history of a year's budget is
  -- readable rather than being one row that changed shape three times.
  supersedes_id   uuid REFERENCES budgets(id),
  version         integer NOT NULL DEFAULT 1,

  created_by      uuid REFERENCES persons(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_budget_status CHECK (status IN ('draft', 'approved', 'superseded')),
  CONSTRAINT ck_budget_year   CHECK (financial_year BETWEEN 2000 AND 2100),
  -- An approved budget with no approver is the exact ambiguity this table exists to
  -- remove: somebody has to have passed it.
  CONSTRAINT ck_budget_approval
    CHECK (status <> 'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

-- One live budget per year. A revision supersedes rather than coexists, or "the budget"
-- stops being a thing anyone can point at.
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_year_live
  ON budgets (society_id, financial_year)
  WHERE status IN ('draft', 'approved');

CREATE INDEX IF NOT EXISTS ix_budget_society ON budgets (society_id, financial_year DESC);

CREATE TABLE IF NOT EXISTS budget_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id   uuid NOT NULL REFERENCES societies(id),
  budget_id    uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,

  -- Against a ledger head, not free text. A budget line that cannot be matched to an
  -- account cannot have an actual, and a variance report with unmatched rows is a
  -- variance report nobody finishes reading.
  account_id   uuid NOT NULL REFERENCES ledger_accounts(id),
  annual_amount numeric(18,4) NOT NULL DEFAULT 0,
  notes        text,

  CONSTRAINT ck_budget_line_amount CHECK (annual_amount >= 0),
  CONSTRAINT uq_budget_line UNIQUE (budget_id, account_id)
);

CREATE INDEX IF NOT EXISTS ix_budget_line_budget ON budget_lines (budget_id);

-- ---------------------------------------------------------------- controls

/**
 * Once approved, the lines are frozen.
 *
 * Enforced here rather than in the service because a control that only holds while the
 * calling code is correct is not a control. Every route into this database - the API, a
 * migration script, a psql session at 2 a.m. - hits this trigger.
 */
CREATE OR REPLACE FUNCTION budget_lines_frozen_when_approved() RETURNS trigger AS $$
DECLARE
  budget_status text;
BEGIN
  SELECT status INTO budget_status
  FROM budgets
  WHERE id = COALESCE(NEW.budget_id, OLD.budget_id);

  IF budget_status <> 'draft' THEN
    RAISE EXCEPTION
      'This budget has been approved. Raise a revision instead of editing the approved one.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_budget_lines_frozen ON budget_lines;
CREATE TRIGGER trg_budget_lines_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION budget_lines_frozen_when_approved();

/**
 * Approval is one-way.
 *
 * A budget can go draft -> approved and approved -> superseded. It can never go back to
 * draft, because "unapprove, edit, re-approve" is precisely the edit the freeze above
 * exists to prevent, taken the long way round.
 */
CREATE OR REPLACE FUNCTION budget_approval_is_one_way() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'approved' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'An approved budget cannot be returned to draft. Raise a revision.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'superseded' AND NEW.status <> 'superseded' THEN
    RAISE EXCEPTION 'A superseded budget cannot be revived.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_budget_approval_one_way ON budgets;
CREATE TRIGGER trg_budget_approval_one_way
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION budget_approval_is_one_way();

-- --------------------------------------------------------------------- RLS

ALTER TABLE budgets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets      FORCE  ROW LEVEL SECURITY;
ALTER TABLE budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON budgets;
CREATE POLICY tenant_isolation ON budgets
  USING      (society_id = nullif(current_setting('app.society_id', true), '')::uuid)
  WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON budget_lines;
CREATE POLICY tenant_isolation ON budget_lines
  USING      (society_id = nullif(current_setting('app.society_id', true), '')::uuid)
  WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON budgets TO watchmygate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON budget_lines TO watchmygate_app;

-- DELETE on budgets is withheld deliberately: a budget the AGM passed is a record of a
-- decision, and superseding it is the only correct way to move on from it. Lines keep
-- DELETE so a draft can be edited freely before approval - the trigger above is what
-- stops that reaching an approved one.
REVOKE DELETE ON budgets FROM watchmygate_app;
