"""Ledger, invoices and payment routing.

Immutability of posted entries is enforced at the database in migration 0002 —
UPDATE and DELETE are revoked from the application role and a trigger raises on any
attempt. Application discipline is not the control; the grant is.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.common.db import Base
from app.common.models import PkMixin, TenantMixin, TimestampMixin

#: numeric(18,4). Four decimal places so intermediate maths (per-sq-ft rates, interest
#: accrual) does not lose precision before the final half-up rounding to paise.
MONEY = Numeric(18, 4)


class AccountType(enum.StrEnum):
    asset = "asset"
    liability = "liability"
    income = "income"
    expense = "expense"
    equity = "equity"


class SourceType(enum.StrEnum):
    invoice = "invoice"
    receipt = "receipt"
    payment = "payment"
    adjustment = "adjustment"
    opening = "opening"
    contra = "contra"


class PeriodStatus(enum.StrEnum):
    open = "open"
    locked = "locked"


class InvoiceStatus(enum.StrEnum):
    draft = "draft"
    issued = "issued"
    partially_paid = "partially_paid"
    paid = "paid"
    void = "void"


class BillingFormula(enum.StrEnum):
    flat = "flat"
    per_sqft = "per_sqft"
    per_bhk = "per_bhk"
    per_meter = "per_meter"
    percentage = "percentage"
    manual = "manual"


class PaymentMethod(enum.StrEnum):
    upi = "upi"
    card = "card"
    netbanking = "netbanking"
    neft = "neft"
    cash = "cash"
    cheque = "cheque"


class PayeeType(enum.StrEnum):
    society = "society"
    person = "person"


class DestinationMode(enum.StrEnum):
    """How money reaches the payee.

    `route_linked` — Razorpay Route, settling to the society's own bank.
    `direct_merchant` — the owner's own gateway account, zero platform commission.

    In both, funds never enter a WatchMyGate account. Anything that would require us to
    receive and forward money needs an RBI Payment Aggregator licence.
    """

    route_linked = "route_linked"
    direct_merchant = "direct_merchant"


class DestinationStatus(enum.StrEnum):
    pending = "pending"
    verified = "verified"
    failed = "failed"
    disabled = "disabled"


class LedgerAccount(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "ledger_accounts"
    __table_args__ = (
        UniqueConstraint("society_id", "code", name="uq_account_society_code"),
        Index("ix_account_society_type", "society_id", "type"),
    )

    code: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    type: Mapped[AccountType] = mapped_column(Enum(AccountType, name="account_type"), nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    #: Corpus and sinking funds — spending needs committee approval, tracked separately.
    is_restricted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class AccountingPeriod(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "accounting_periods"
    __table_args__ = (
        UniqueConstraint("society_id", "starts_on", name="uq_period_society_start"),
        Index("ix_period_range", "society_id", "starts_on", "ends_on"),
    )

    starts_on: Mapped[dt.date] = mapped_column(Date, nullable=False)
    ends_on: Mapped[dt.date] = mapped_column(Date, nullable=False)
    status: Mapped[PeriodStatus] = mapped_column(
        Enum(PeriodStatus, name="period_status"), nullable=False, default=PeriodStatus.open
    )
    locked_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    locked_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    #: Two-person control: reopening a closed book is how fraud happens.
    reopened_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    reopened_approved_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))


class JournalEntry(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "journal_entries"
    __table_args__ = (
        UniqueConstraint("society_id", "entry_number", name="uq_journal_society_number"),
        Index("ix_journal_date", "society_id", "entry_date"),
        Index("ix_journal_source", "society_id", "source_type", "source_id"),
    )

    entry_number: Mapped[str] = mapped_column(String(24), nullable=False)
    entry_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    narration: Mapped[str] = mapped_column(Text, nullable=False)
    source_type: Mapped[SourceType] = mapped_column(
        Enum(SourceType, name="journal_source_type"), nullable=False
    )
    source_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    posted_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    posted_by: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    #: Corrections are reversing entries, never edits.
    reverses_entry_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    period_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))


class JournalLine(PkMixin, TenantMixin, Base):
    __tablename__ = "journal_lines"
    __table_args__ = (
        CheckConstraint("debit >= 0 AND credit >= 0", name="ck_line_non_negative"),
        # Exactly one side. Prevents the classic "both zero" or "both set" line that
        # silently unbalances a report months later.
        CheckConstraint("(debit = 0) <> (credit = 0)", name="ck_line_one_sided"),
        Index("ix_line_entry", "journal_entry_id"),
        Index("ix_line_account", "society_id", "account_id"),
        Index("ix_line_unit", "society_id", "unit_id"),
    )

    journal_entry_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("journal_entries.id", ondelete="RESTRICT"), nullable=False
    )
    account_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("ledger_accounts.id", ondelete="RESTRICT"), nullable=False
    )
    debit: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    credit: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    unit_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))


class ChargeType(PkMixin, TenantMixin, TimestampMixin, Base):
    """A billable head — maintenance, water, sinking fund, penalty."""

    __tablename__ = "charge_types"
    __table_args__ = (UniqueConstraint("society_id", "code", name="uq_charge_society_code"),)

    code: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    formula: Mapped[BillingFormula] = mapped_column(
        Enum(BillingFormula, name="billing_formula"), nullable=False
    )
    rate: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    account_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    #: GST applies only above ₹7,500/month/member AND ₹20L society turnover — encoded
    #: as a rule at billing time, never hardcoded here.
    gst_applicable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    gst_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=18)
    is_recurring: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Invoice(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "invoices"
    __table_args__ = (
        UniqueConstraint("society_id", "invoice_number", name="uq_invoice_society_number"),
        Index("ix_invoice_unit_status", "society_id", "unit_id", "status"),
        # Defaulter queries: unpaid, past due. Partial index keeps it small.
        Index(
            "ix_invoice_outstanding",
            "society_id",
            "due_date",
            postgresql_where="status IN ('issued', 'partially_paid')",
        ),
    )

    unit_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    invoice_number: Mapped[str] = mapped_column(String(32), nullable=False)
    period_start: Mapped[dt.date] = mapped_column(Date, nullable=False)
    period_end: Mapped[dt.date] = mapped_column(Date, nullable=False)
    issue_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    due_date: Mapped[dt.date] = mapped_column(Date, nullable=False)

    subtotal: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    gst_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    late_fee: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    total: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")

    status: Mapped[InvoiceStatus] = mapped_column(
        Enum(InvoiceStatus, name="invoice_status"), nullable=False, default=InvoiceStatus.draft
    )
    #: Resolved from unit_occupancies at issue time and frozen. If the tenant moves out
    #: next week, this invoice still belongs to whoever was liable when it was raised.
    liable_person_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))


class InvoiceLine(PkMixin, TenantMixin, Base):
    __tablename__ = "invoice_lines"
    __table_args__ = (Index("ix_invoice_line_invoice", "invoice_id"),)

    invoice_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False
    )
    charge_type_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    description: Mapped[str] = mapped_column(String(300), nullable=False)
    quantity: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=1)
    rate: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    gst_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=0)
    gst_amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)


class PaymentDestination(PkMixin, TenantMixin, TimestampMixin, Base):
    """Where money for a charge goes. See design/PAYMENTS.md.

    Mode 2 (`direct_merchant`) is the owner's own gateway account, so tenant rent lands
    in their bank with no WatchMyGate commission. Credentials are **references to
    Secret Manager paths** — never the secrets themselves, which are the most sensitive
    data in the system.
    """

    __tablename__ = "payment_destinations"
    __table_args__ = (
        Index("ix_destination_payee", "society_id", "payee_type", "payee_id"),
    )

    payee_type: Mapped[PayeeType] = mapped_column(Enum(PayeeType, name="payee_type"), nullable=False)
    payee_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    mode: Mapped[DestinationMode] = mapped_column(
        Enum(DestinationMode, name="destination_mode"), nullable=False
    )
    provider: Mapped[str] = mapped_column(String(32), nullable=False, default="razorpay")
    merchant_id: Mapped[str | None] = mapped_column(String(120))
    credentials_secret_ref: Mapped[str | None] = mapped_column(String(300))
    webhook_secret_ref: Mapped[str | None] = mapped_column(String(300))
    status: Mapped[DestinationStatus] = mapped_column(
        Enum(DestinationStatus, name="destination_status"),
        nullable=False,
        default=DestinationStatus.pending,
    )
    verified_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    #: Per-unit virtual account from Razorpay Smart Collect, for NEFT/IMPS/UPI
    #: auto-reconciliation.
    virtual_account_number: Mapped[str | None] = mapped_column(String(64))
    virtual_ifsc: Mapped[str | None] = mapped_column(String(16))


class Receipt(PkMixin, TenantMixin, TimestampMixin, Base):
    __tablename__ = "receipts"
    __table_args__ = (
        # Webhook idempotency. Razorpay retries aggressively; an insert conflict here
        # is the correct, boring outcome rather than a duplicate receipt.
        UniqueConstraint("provider_event_id", name="uq_receipt_provider_event"),
        UniqueConstraint("society_id", "receipt_number", name="uq_receipt_society_number"),
        Index("ix_receipt_unit", "society_id", "unit_id"),
    )

    unit_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    receipt_number: Mapped[str] = mapped_column(String(32), nullable=False)
    received_on: Mapped[dt.date] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="INR")
    method: Mapped[PaymentMethod] = mapped_column(
        Enum(PaymentMethod, name="payment_method"), nullable=False
    )
    provider_payment_id: Mapped[str | None] = mapped_column(String(120))
    provider_event_id: Mapped[str | None] = mapped_column(String(160))
    destination_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    journal_entry_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    payer_person_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    #: Set when the payer entered a UTR manually because the owner had not configured
    #: our webhook. Never marks an invoice paid on its own.
    unverified_utr: Mapped[str | None] = mapped_column(String(40))
    verified_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))


class ReceiptAllocation(PkMixin, TenantMixin, Base):
    __tablename__ = "receipt_allocations"
    __table_args__ = (
        Index("ix_allocation_receipt", "receipt_id"),
        Index("ix_allocation_invoice", "invoice_id"),
    )

    receipt_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("receipts.id", ondelete="RESTRICT"), nullable=False
    )
    invoice_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False
    )
    amount: Mapped[Decimal] = mapped_column(MONEY, nullable=False)


class ChargeTypeRouting(PkMixin, TenantMixin, TimestampMixin, Base):
    """Which destination collects which charge type.

    Lets maintenance route to the society (Mode 1) while rent routes to each flat owner
    (Mode 2) in the same society.
    """

    __tablename__ = "charge_type_routing"
    __table_args__ = (
        UniqueConstraint("society_id", "charge_type_code", "unit_id", name="uq_routing"),
    )

    charge_type_code: Mapped[str] = mapped_column(String(32), nullable=False)
    unit_id: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    destination_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)


class GstRule(PkMixin, TenantMixin, TimestampMixin, Base):
    """Statutory thresholds as data, not code.

    GST on society maintenance applies only when the monthly charge per member exceeds
    the threshold **and** society turnover exceeds its own threshold. Both move with
    legislation, so they are rows.
    """

    __tablename__ = "gst_rules"

    effective_from: Mapped[dt.date] = mapped_column(Date, nullable=False)
    monthly_threshold_per_member: Mapped[Decimal] = mapped_column(
        MONEY, nullable=False, default=7500
    )
    annual_turnover_threshold: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=2000000)
    rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, default=18)
    society_turnover: Mapped[Decimal] = mapped_column(MONEY, nullable=False, default=0)
    late_fee_percent_per_month: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False, default=0
    )
    grace_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
