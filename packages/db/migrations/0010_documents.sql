-- The document repository (MG-30) and rental agreements (MG-32).
--
-- Every society keeps the same shelf of paper: bye-laws, registration certificate, AGM
-- minutes, audited accounts, insurance, AMC contracts, rental agreements. Today it lives
-- in one secretary's WhatsApp and leaves with them when the committee turns over, which
-- is the actual problem — not storage.
--
-- Built on the existing `attachments` machinery: bytes go to R2 by presigned URL and
-- never through the API. This table is the *index* over them, with the two properties
-- that decide whether a repository is used or abandoned:
--
--   1. **Visibility.** An AGM minute is for everyone; a vendor contract with rates in it
--      is committee-only; a rental agreement belongs to one flat. One repository serving
--      all three needs the distinction, or a secretary will keep the sensitive half on
--      WhatsApp exactly as before.
--
--   2. **Expiry.** An insurance policy that lapsed in March is worse than no policy at
--      all, because everyone believes there is cover. Documents that expire carry a date
--      and the console counts down.

CREATE TABLE IF NOT EXISTS documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES societies(id),
  title         varchar(200) NOT NULL,
  category      varchar(40)  NOT NULL,
  description   text,

  -- Where the bytes are. Nullable because a document can be recorded before it is
  -- scanned — a committee noting "the 2019 AGM minutes exist, somewhere" is useful.
  r2_key        varchar(500),
  content_type  varchar(120),
  bytes         integer,

  -- 'society'  everyone in the society
  -- 'committee' committee and admin only
  -- 'unit'     one flat: its occupants, plus the committee
  visibility    varchar(16)  NOT NULL DEFAULT 'society',
  unit_id       uuid REFERENCES units(id),

  -- Versioning by supersession rather than by editing. An audited account that can be
  -- swapped out is not an audited account.
  version       integer      NOT NULL DEFAULT 1,
  supersedes_id uuid REFERENCES documents(id),

  effective_from date,
  expires_on     date,

  uploaded_by   uuid REFERENCES persons(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_document_visibility
    CHECK (visibility IN ('society', 'committee', 'unit')),

  -- A flat-scoped document without a flat is a document nobody can route, and one that
  -- would fall through the visibility check into being visible to everyone.
  CONSTRAINT ck_document_unit_scope
    CHECK (visibility <> 'unit' OR unit_id IS NOT NULL),

  CONSTRAINT ck_document_dates
    CHECK (expires_on IS NULL OR effective_from IS NULL OR expires_on >= effective_from)
);

CREATE INDEX IF NOT EXISTS ix_document_society
  ON documents (society_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_document_unit ON documents (society_id, unit_id);
-- Partial: the console asks "what is about to lapse" constantly and "what never expires"
-- never.
CREATE INDEX IF NOT EXISTS ix_document_expiry
  ON documents (society_id, expires_on) WHERE expires_on IS NOT NULL;

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON documents;
CREATE POLICY tenant_isolation ON documents
  USING      (society_id = nullif(current_setting('app.society_id', true), '')::uuid)
  WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO watchmygate_app;

-- ------------------------------------------------------------------ note
--
-- Deliberately *not* append-only, unlike the consent ledger and the journal.
--
-- A document repository has to tolerate a secretary uploading the wrong file and fixing
-- it a minute later. Making that impossible would push people back to WhatsApp, which is
-- a worse outcome for the same data. Supersession covers the case that actually matters
-- — replacing a signed document while keeping the old one findable — and the audit log
-- records deletions either way.
