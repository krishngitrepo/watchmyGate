"""Billing formulas and GST — the single implementation of every money rule.

Clients never compute money. This module runs server-side only; the app and the admin
console display what the API returns, and a live total while a bill is being edited
comes from `POST /v1/billing/preview`. That is why the total a resident sees and the
total filed for GST cannot differ by a paisa: there is only one calculation.

Every function here is pure — no database, no clock, no I/O — so the golden vectors in
`packages/billing/golden-vectors.json` fully specify the behaviour and the Dart side
can be checked against the same file.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal

from app.common.errors import ValidationError
from app.common.money import ZERO, apply_rate, money, quantise
from app.modules.ledger.models import BillingFormula


@dataclass(frozen=True)
class UnitFacts:
    """What a formula may consider about a flat."""

    carpet_area_sqft: Decimal | None = None
    bhk: int | None = None
    meter_reading_units: Decimal | None = None
    base_amount: Decimal | None = None


@dataclass(frozen=True)
class ChargeSpec:
    code: str
    name: str
    formula: BillingFormula
    rate: Decimal
    gst_applicable: bool = False
    gst_rate: Decimal = Decimal("18")


@dataclass(frozen=True)
class ComputedLine:
    code: str
    description: str
    quantity: Decimal
    rate: Decimal
    amount: Decimal
    gst_rate: Decimal
    gst_amount: Decimal


@dataclass(frozen=True)
class GstContext:
    """Statutory GST test.

    GST on society maintenance applies only when the monthly charge per member exceeds
    the threshold (₹7,500) **and** the society's annual turnover exceeds its own
    threshold (₹20 lakh). Both conditions, not either — societies routinely get this
    wrong and over-charge their members.
    """

    monthly_threshold_per_member: Decimal = Decimal("7500")
    annual_turnover_threshold: Decimal = Decimal("2000000")
    society_turnover: Decimal = ZERO
    rate: Decimal = Decimal("18")


def compute_line(spec: ChargeSpec, facts: UnitFacts) -> ComputedLine:
    """Apply one charge formula to one flat.

    Raises rather than silently billing zero when the data a formula needs is missing —
    a flat with no recorded area must not quietly receive a ₹0 maintenance bill.
    """
    quantity: Decimal
    rate = money(spec.rate)

    if spec.formula is BillingFormula.flat:
        quantity = Decimal("1")
        amount = rate

    elif spec.formula is BillingFormula.per_sqft:
        if facts.carpet_area_sqft is None:
            raise ValidationError(
                f"Cannot bill '{spec.name}': this flat has no carpet area recorded."
            )
        quantity = money(facts.carpet_area_sqft)
        amount = quantise(quantity * rate)

    elif spec.formula is BillingFormula.per_bhk:
        if facts.bhk is None:
            raise ValidationError(
                f"Cannot bill '{spec.name}': this flat has no BHK recorded."
            )
        quantity = Decimal(facts.bhk)
        amount = quantise(quantity * rate)

    elif spec.formula is BillingFormula.per_meter:
        if facts.meter_reading_units is None:
            raise ValidationError(
                f"Cannot bill '{spec.name}': no meter reading for this period."
            )
        quantity = money(facts.meter_reading_units)
        amount = quantise(quantity * rate)

    elif spec.formula is BillingFormula.percentage:
        if facts.base_amount is None:
            raise ValidationError(
                f"Cannot bill '{spec.name}': no base amount to take a percentage of."
            )
        quantity = Decimal("1")
        amount = apply_rate(money(facts.base_amount), rate)

    elif spec.formula is BillingFormula.manual:
        if facts.base_amount is None:
            raise ValidationError(f"Cannot bill '{spec.name}': no amount entered.")
        quantity = Decimal("1")
        amount = money(facts.base_amount)

    else:  # pragma: no cover — enum is exhaustive
        raise ValidationError(f"Unknown billing formula: {spec.formula}")

    return ComputedLine(
        code=spec.code,
        description=spec.name,
        quantity=quantity,
        rate=rate,
        amount=amount,
        gst_rate=spec.gst_rate if spec.gst_applicable else ZERO,
        gst_amount=ZERO,  # filled by apply_gst once the monthly total is known
    )


def gst_applies(monthly_total_per_member: Decimal, ctx: GstContext) -> bool:
    """Both statutory conditions must hold."""
    return (
        monthly_total_per_member > ctx.monthly_threshold_per_member
        and ctx.society_turnover > ctx.annual_turnover_threshold
    )


def apply_gst(lines: list[ComputedLine], ctx: GstContext) -> list[ComputedLine]:
    """Add GST to eligible lines, but only if the society-level test passes.

    The threshold test uses the **total monthly charge for the member**, not the
    individual line — a ₹6,000 maintenance charge plus ₹2,000 of water crosses ₹7,500
    together even though neither does alone.
    """
    monthly_total = sum((line.amount for line in lines), ZERO)

    if not gst_applies(monthly_total, ctx):
        return [
            ComputedLine(
                code=line.code,
                description=line.description,
                quantity=line.quantity,
                rate=line.rate,
                amount=line.amount,
                gst_rate=ZERO,
                gst_amount=ZERO,
            )
            for line in lines
        ]

    return [
        ComputedLine(
            code=line.code,
            description=line.description,
            quantity=line.quantity,
            rate=line.rate,
            amount=line.amount,
            gst_rate=line.gst_rate,
            gst_amount=apply_rate(line.amount, line.gst_rate) if line.gst_rate else ZERO,
        )
        for line in lines
    ]


def late_fee(
    outstanding: Decimal,
    due_date: dt.date,
    as_of: dt.date,
    *,
    percent_per_month: Decimal,
    grace_days: int = 0,
) -> Decimal:
    """Simple (not compound) interest on overdue maintenance.

    Simple interest is deliberate: most society bye-laws specify simple interest, and
    compounding a maintenance arrear is the kind of thing that gets challenged at an
    AGM. Part months are charged as whole months, which is the common convention —
    it must be stated on the bill.
    """
    if percent_per_month <= 0 or outstanding <= 0:
        return ZERO

    effective_due = due_date + dt.timedelta(days=grace_days)
    if as_of <= effective_due:
        return ZERO

    days_late = (as_of - effective_due).days
    months_late = (days_late + 29) // 30  # part month counts as a full month

    return quantise(money(outstanding) * percent_per_month / Decimal("100") * months_late)


@dataclass(frozen=True)
class InvoiceTotals:
    subtotal: Decimal
    gst_amount: Decimal
    late_fee: Decimal
    total: Decimal


def total_invoice(lines: list[ComputedLine], *, late_fee_amount: Decimal = ZERO) -> InvoiceTotals:
    """Sum an invoice.

    Totals are computed from the already-quantised line amounts, so the printed lines
    always add up to the printed total. Summing unrounded values and rounding at the
    end would produce a bill whose own lines do not tally — the first thing an
    accountant notices.
    """
    subtotal = sum((line.amount for line in lines), ZERO)
    gst_amount = sum((line.gst_amount for line in lines), ZERO)
    fee = quantise(late_fee_amount)

    return InvoiceTotals(
        subtotal=quantise(subtotal),
        gst_amount=quantise(gst_amount),
        late_fee=fee,
        total=quantise(subtotal + gst_amount + fee),
    )
