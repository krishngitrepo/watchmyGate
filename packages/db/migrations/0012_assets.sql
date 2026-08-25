-- The asset and inventory register (MG-7).
--
-- On every RFP, and for a reason that is not really about inventory. A society's physical
-- plant - lifts, pumps, gensets, the STP, the fire system - is the largest thing it owns
-- and the thing whose neglect is most expensive. What the committee actually loses when
-- the register lives in one facility manager's head is not the list. It is:
--
--   * which lift is under AMC and until when, on the morning it stops between floors;
--   * that the DG set service was due in March and nobody noticed until the June outage;
--   * the fixed-asset schedule the auditor asks for every single year;
--   * what the outgoing committee actually handed over.
--
-- Two tables. `assets` is what the society owns. `asset_maintenance` is the work - due,
-- overdue or done - because a register without a schedule attached is a list nobody opens
-- twice.
--
-- Deliberately *not* modelled: depreciation as stored figures. See the note at the end.

CREATE TABLE IF NOT EXISTS assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      uuid NOT NULL REFERENCES societies(id),

  -- The society's own tag, the one physically stuck on the machine. Unique, because two
  -- assets tagged LIFT-A-01 is the failure this register exists to prevent.
  code            varchar(40)  NOT NULL,
  name            varchar(160) NOT NULL,
  category        varchar(40)  NOT NULL,

  -- Where it physically is. `tower_id` when it belongs to one tower, free text always,
  -- because "basement 2, near the ramp" is how a facility manager gives directions and no
  -- enumeration will ever capture it.
  tower_id        uuid REFERENCES towers(id),
  location        varchar(200),

  make_model      varchar(160),
  serial_number   varchar(120),

  purchase_date   date,
  purchase_cost   numeric(18,4) NOT NULL DEFAULT 0,
  supplier        varchar(160),
  invoice_ref     varchar(120),
  warranty_until  date,

  -- Straight-line life, for the fixed-asset schedule. Nullable: a society that has never
  -- thought about depreciation should not be blocked from recording that it owns a pump.
  expected_life_years integer,

  -- AMC as dates plus an optional pointer into the document repository, rather than a
  -- second contract store. The contract is a document; this is the fact that one exists.
  amc_vendor      varchar(160),
  amc_until       date,
  amc_document_id uuid REFERENCES documents(id),

  condition       varchar(20) NOT NULL DEFAULT 'good',
  status          varchar(20) NOT NULL DEFAULT 'in_use',
  disposed_on     date,
  disposal_note   text,

  notes           text,
  recorded_by     uuid REFERENCES persons(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_asset_code UNIQUE (society_id, code),
  CONSTRAINT ck_asset_condition
    CHECK (condition IN ('good', 'fair', 'poor', 'out_of_service')),
  CONSTRAINT ck_asset_status
    CHECK (status IN ('in_use', 'in_store', 'disposed')),
  CONSTRAINT ck_asset_cost CHECK (purchase_cost >= 0),
  CONSTRAINT ck_asset_life CHECK (expected_life_years IS NULL OR expected_life_years > 0),
  -- A disposed asset with no disposal date is the ambiguity that makes a handover
  -- argument: was it sold, scrapped, or is it in the basement?
  CONSTRAINT ck_asset_disposal
    CHECK (status <> 'disposed' OR disposed_on IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ix_asset_society   ON assets (society_id, category, code);
CREATE INDEX IF NOT EXISTS ix_asset_tower     ON assets (society_id, tower_id);
-- The console asks "what AMC is about to lapse" constantly and "what has no AMC" never.
CREATE INDEX IF NOT EXISTS ix_asset_amc
  ON assets (society_id, amc_until) WHERE amc_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS asset_maintenance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id      uuid NOT NULL REFERENCES societies(id),
  asset_id        uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,

  -- `statutory` is not padding: lift licences and fire NOCs are renewed on a legal clock
  -- in most Indian states, and missing one is a different category of problem from
  -- missing a service.
  kind            varchar(24) NOT NULL DEFAULT 'service',
  due_on          date NOT NULL,
  -- Null for a one-off job. Set, and completing this one schedules the next.
  interval_months integer,

  completed_on    date,
  vendor          varchar(160),
  cost            numeric(18,4),
  notes           text,

  recorded_by     uuid REFERENCES persons(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_maintenance_kind
    CHECK (kind IN ('service', 'inspection', 'amc_visit', 'statutory', 'repair')),
  CONSTRAINT ck_maintenance_interval
    CHECK (interval_months IS NULL OR interval_months BETWEEN 1 AND 120),
  CONSTRAINT ck_maintenance_cost CHECK (cost IS NULL OR cost >= 0)
);

CREATE INDEX IF NOT EXISTS ix_maintenance_asset ON asset_maintenance (asset_id, due_on DESC);
-- The one query the facility page runs on load: what is due and not yet done.
CREATE INDEX IF NOT EXISTS ix_maintenance_due
  ON asset_maintenance (society_id, due_on) WHERE completed_on IS NULL;

-- ---------------------------------------------------------------- controls

/**
 * A completed job cannot be un-completed or re-dated.
 *
 * The maintenance log is the evidence a society produces when a lift injures somebody and
 * the question is whether it was serviced. A log whose entries can be edited afterwards
 * proves nothing, and the temptation to tidy it up arrives exactly when it matters most.
 * Correcting a genuine mistake means recording another entry, the same way the journal
 * takes a contra rather than an edit.
 */
CREATE OR REPLACE FUNCTION maintenance_completion_is_final() RETURNS trigger AS $$
BEGIN
  IF OLD.completed_on IS NOT NULL THEN
    IF NEW.completed_on IS DISTINCT FROM OLD.completed_on
       OR NEW.due_on   IS DISTINCT FROM OLD.due_on
       OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
       OR NEW.cost     IS DISTINCT FROM OLD.cost THEN
      RAISE EXCEPTION
        'This job is already recorded as done. Record a new entry rather than editing it.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_maintenance_final ON asset_maintenance;
CREATE TRIGGER trg_maintenance_final
  BEFORE UPDATE ON asset_maintenance
  FOR EACH ROW EXECUTE FUNCTION maintenance_completion_is_final();

-- --------------------------------------------------------------------- RLS

ALTER TABLE assets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets            FORCE  ROW LEVEL SECURITY;
ALTER TABLE asset_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_maintenance FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON assets;
CREATE POLICY tenant_isolation ON assets
  USING      (society_id = nullif(current_setting('app.society_id', true), '')::uuid)
  WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation ON asset_maintenance;
CREATE POLICY tenant_isolation ON asset_maintenance
  USING      (society_id = nullif(current_setting('app.society_id', true), '')::uuid)
  WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON assets            TO watchmygate_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_maintenance TO watchmygate_app;

-- ------------------------------------------------------------------- notes
--
-- **Depreciation is computed, never stored.** A stored written-down value drifts the
-- moment anybody edits the cost or the life, and then the register and the auditor's
-- schedule disagree with no way to tell which moved. The API computes straight-line
-- depreciation on the fly and labels the report as management information - because a
-- co-operative society's auditor may well use the written-down-value method instead, and
-- a figure of ours presented as if it were theirs is worse than no figure.
--
-- **The register tolerates editing, unlike the maintenance log.** A facility manager
-- correcting a serial number they typed wrong must not be pushed back to a spreadsheet.
-- What must not be editable is the record that a job was done, and that is what the
-- trigger above protects.
