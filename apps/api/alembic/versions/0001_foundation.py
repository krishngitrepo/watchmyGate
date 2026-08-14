"""Foundation: core schema, application role, Row-Level Security, immutable audit log.

Revision ID: 0001_foundation
Revises:
Create Date: 2026-08-13

This migration establishes the isolation guarantee the whole platform rests on:

* An application role created ``NOBYPASSRLS`` and without table ownership, so it is
  structurally incapable of reading across societies even if application code is wrong.
* An RLS policy on every tenant-scoped table comparing ``society_id`` against
  ``current_setting('app.society_id')``, which ``tenant_context`` sets per transaction.
* ``FORCE ROW LEVEL SECURITY`` so policies apply to the table owner too.
* ``current_setting(..., true)`` returns NULL when unset, making the comparison false —
  an unscoped query therefore returns **zero rows** rather than everything. Fails closed.
* INSERT-only grants on ``audit_log``, so a compromised application cannot rewrite history.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0001_foundation"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


#: Every table carrying society_id. Adding a tenant table without adding it here is a
#: security bug — tests/test_tenant_isolation.py asserts this list matches the database.
TENANT_TABLES: tuple[str, ...] = (
    "towers",
    "units",
    "unit_occupancies",
    "role_assignments",
)

APP_ROLE = "watchmygate_app"


def upgrade() -> None:
    # ------------------------------------------------------------------ enums
    society_status = postgresql.ENUM(
        "onboarding", "active", "suspended", name="society_status", create_type=False
    )
    plan_tier = postgresql.ENUM("basic", "pro", "enterprise", name="plan_tier", create_type=False)
    unit_status = postgresql.ENUM(
        "occupied", "vacant", "under_renovation", name="unit_status", create_type=False
    )
    occupancy_relationship = postgresql.ENUM(
        "owner",
        "tenant",
        "family_member",
        "occupant",
        name="occupancy_relationship",
        create_type=False,
    )
    person_status = postgresql.ENUM(
        "active", "deactivated", name="person_status", create_type=False
    )
    role_code = postgresql.ENUM(
        "super_admin",
        "society_admin",
        "mc_member",
        "accountant",
        "auditor",
        "guard",
        "resident",
        "staff",
        name="role_code",
        create_type=False,
    )
    role_scope_type = postgresql.ENUM(
        "society", "tower", "unit", name="role_scope_type", create_type=False
    )

    for enum in (
        society_status,
        plan_tier,
        unit_status,
        occupancy_relationship,
        person_status,
        role_code,
        role_scope_type,
    ):
        enum.create(op.get_bind(), checkfirst=True)

    # ------------------------------------------------------------- societies
    op.create_table(
        "societies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("slug", sa.String(80), nullable=False, unique=True),
        sa.Column("state_code", sa.String(2), nullable=False),
        sa.Column("plan_tier", plan_tier, nullable=False, server_default="basic"),
        sa.Column("timezone", sa.String(64), nullable=False, server_default="Asia/Kolkata"),
        sa.Column("status", society_status, nullable=False, server_default="onboarding"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )

    # ----------------------------------------------------------------- people
    op.create_table(
        "persons",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("phone", sa.String(16), nullable=False, unique=True),
        sa.Column("name", sa.String(200)),
        sa.Column("email", sa.String(320)),
        sa.Column("status", person_status, nullable=False, server_default="active"),
        sa.Column("totp_enrolled", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )

    op.create_table(
        "roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("code", role_code, nullable=False, unique=True),
        sa.Column("name", sa.String(80), nullable=False),
    )

    op.create_table(
        "otp_challenges",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("phone", sa.String(16), nullable=False),
        sa.Column("code_hash", sa.String(255), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.Column("request_ip", postgresql.INET),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_otp_phone_active", "otp_challenges", ["phone", "expires_at"])

    op.create_table(
        "sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "person_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("refresh_token_hash", sa.String(255), nullable=False),
        sa.Column("device_id", sa.String(128)),
        sa.Column("device_label", sa.String(128)),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("rotated_to", postgresql.UUID(as_uuid=True)),
        sa.Column("last_used_at", sa.DateTime(timezone=True)),
        sa.Column("ip", postgresql.INET),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("refresh_token_hash", name="uq_session_refresh_hash"),
    )
    op.create_index(
        "ix_session_person_active",
        "sessions",
        ["person_id"],
        postgresql_where=sa.text("revoked_at IS NULL"),
    )

    # --------------------------------------------------- tenant-scoped tables
    op.create_table(
        "towers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "society_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("societies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("floors", sa.Integer),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("society_id", "name", name="uq_tower_society_name"),
    )
    op.create_index("ix_towers_society_id", "towers", ["society_id"])

    op.create_table(
        "units",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "society_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("societies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "tower_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("towers.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("number", sa.String(32), nullable=False),
        sa.Column("floor", sa.Integer),
        sa.Column("carpet_area_sqft", sa.Numeric(10, 2)),
        sa.Column("bhk", sa.Integer),
        sa.Column("status", unit_status, nullable=False, server_default="vacant"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint(
            "society_id", "tower_id", "number", name="uq_unit_society_tower_number"
        ),
    )
    op.create_index("ix_units_society_id", "units", ["society_id"])
    op.create_index("ix_units_society_status", "units", ["society_id", "status"])

    op.create_table(
        "unit_occupancies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "society_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("societies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "person_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("persons.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("relationship", occupancy_relationship, nullable=False),
        sa.Column("is_billing_liable", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("has_voting_right", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("has_app_access", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("valid_from", sa.Date, nullable=False),
        sa.Column("valid_to", sa.Date),
        sa.Column("superseded_at", sa.DateTime(timezone=True)),
        sa.Column("created_by", postgresql.UUID(as_uuid=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "valid_to IS NULL OR valid_to >= valid_from", name="ck_occupancy_valid_range"
        ),
    )
    op.create_index("ix_unit_occupancies_society_id", "unit_occupancies", ["society_id"])
    op.create_index("ix_occupancy_person", "unit_occupancies", ["society_id", "person_id"])
    op.create_index(
        "ix_occupancy_current",
        "unit_occupancies",
        ["society_id", "unit_id"],
        postgresql_where=sa.text("valid_to IS NULL AND superseded_at IS NULL"),
    )

    op.create_table(
        "role_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "society_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("societies.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "person_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "role_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("roles.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("scope_type", role_scope_type, nullable=False, server_default="society"),
        sa.Column("scope_id", postgresql.UUID(as_uuid=True)),
        sa.Column("valid_from", sa.Date, nullable=False),
        sa.Column("valid_to", sa.Date),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_role_assignments_society_id", "role_assignments", ["society_id"])
    op.create_index("ix_role_assignment_person", "role_assignments", ["person_id", "society_id"])
    op.create_index(
        "ix_role_assignment_active",
        "role_assignments",
        ["society_id", "person_id"],
        postgresql_where=sa.text("valid_to IS NULL"),
    )

    # ------------------------------------------------- audit log (partitioned)
    op.execute("""
        CREATE TABLE audit_log (
            id              uuid NOT NULL,
            created_at      timestamptz NOT NULL DEFAULT now(),
            society_id      uuid,
            actor_person_id uuid,
            action          varchar(80)  NOT NULL,
            entity_type     varchar(80)  NOT NULL,
            entity_id       uuid,
            before          jsonb,
            after           jsonb,
            reason          varchar(500),
            ip              inet,
            user_agent      varchar(400),
            PRIMARY KEY (id, created_at)
        ) PARTITION BY RANGE (created_at);
    """)
    op.execute("CREATE INDEX ix_audit_society_created ON audit_log (society_id, created_at);")
    op.execute("CREATE INDEX ix_audit_entity ON audit_log (entity_type, entity_id);")
    op.execute("CREATE INDEX ix_audit_actor ON audit_log (actor_person_id, created_at);")

    # Rolling partitions. The worker creates future months ahead of time; these cover
    # the current window so a fresh database is immediately writable.
    op.execute("""
        DO $$
        DECLARE
            start_month date := date_trunc('month', now())::date - interval '1 month';
            i int;
            part_start date;
            part_end date;
        BEGIN
            FOR i IN 0..12 LOOP
                part_start := (start_month + (i || ' month')::interval)::date;
                part_end   := (start_month + ((i + 1) || ' month')::interval)::date;
                EXECUTE format(
                    'CREATE TABLE IF NOT EXISTS audit_log_%s PARTITION OF audit_log
                       FOR VALUES FROM (%L) TO (%L)',
                    to_char(part_start, 'YYYY_MM'), part_start, part_end
                );
            END LOOP;
        END $$;
    """)

    # ------------------------------------------------------- application role
    # Created NOBYPASSRLS and without ownership: structurally unable to cross tenants.
    op.execute(f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                CREATE ROLE {APP_ROLE} LOGIN PASSWORD 'localdev_app' NOBYPASSRLS;
            ELSE
                ALTER ROLE {APP_ROLE} NOBYPASSRLS;
            END IF;
        END $$;
    """)
    op.execute(f"GRANT USAGE ON SCHEMA public TO {APP_ROLE};")
    op.execute(
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {APP_ROLE};"
    )
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {APP_ROLE};")
    op.execute(
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {APP_ROLE};"
    )

    # Audit log is append-only for the application. History cannot be rewritten.
    op.execute(f"REVOKE UPDATE, DELETE ON audit_log FROM {APP_ROLE};")
    op.execute(f"GRANT INSERT, SELECT ON audit_log TO {APP_ROLE};")

    # ---------------------------------------------------- Row-Level Security
    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY;")
        # FORCE so the policy applies to the table owner too — otherwise a migration
        # or admin connection would silently see everything.
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY;")
        # nullif(..., '') is load-bearing, not defensive noise.
        #
        # set_config(..., is_local => true) resets to the EMPTY STRING at transaction
        # end, not to NULL. So on a pooled connection that previously served a scoped
        # request, current_setting('app.society_id', true) returns '' and a bare
        # ''::uuid raises InvalidTextRepresentation instead of filtering. That made
        # unscoped behaviour depend on whether the connection had been reused — an
        # error on a warm connection, clean zero rows on a cold one.
        #
        # nullif() turns both cases into NULL, the comparison into NULL, and the row
        # into a non-match. Unscoped queries therefore return zero rows, always.
        op.execute(f"""
            CREATE POLICY tenant_isolation ON {table}
                USING      (society_id = nullif(current_setting('app.society_id', true), '')::uuid)
                WITH CHECK (society_id = nullif(current_setting('app.society_id', true), '')::uuid);
        """)

    # ------------------------------------------------------------ seed roles
    op.execute("""
        INSERT INTO roles (id, code, name) VALUES
            (gen_random_uuid(), 'super_admin',    'Platform Super Admin'),
            (gen_random_uuid(), 'society_admin',  'Society Admin'),
            (gen_random_uuid(), 'mc_member',      'Committee Member'),
            (gen_random_uuid(), 'accountant',     'Accountant'),
            (gen_random_uuid(), 'auditor',        'Auditor (read-only)'),
            (gen_random_uuid(), 'guard',          'Security Guard'),
            (gen_random_uuid(), 'resident',       'Resident'),
            (gen_random_uuid(), 'staff',          'Staff / Vendor')
        ON CONFLICT (code) DO NOTHING;
    """)


def downgrade() -> None:
    for table in TENANT_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table};")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY;")

    op.execute("DROP TABLE IF EXISTS audit_log CASCADE;")
    op.drop_table("role_assignments")
    op.drop_table("unit_occupancies")
    op.drop_table("units")
    op.drop_table("towers")
    op.drop_table("sessions")
    op.drop_table("otp_challenges")
    op.drop_table("roles")
    op.drop_table("persons")
    op.drop_table("societies")

    for enum_name in (
        "role_scope_type",
        "role_code",
        "person_status",
        "occupancy_relationship",
        "unit_status",
        "plan_tier",
        "society_status",
    ):
        op.execute(f"DROP TYPE IF EXISTS {enum_name};")
