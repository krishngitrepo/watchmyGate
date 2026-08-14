"""Money handling.

Two rules, both non-negotiable:

1. Money is `Decimal`, never `float`. Postgres columns are `numeric(18,4)` and asyncpg
   maps them to `Decimal` directly, so the boundary is clean in both directions.
2. Money is computed **server-side only**. Clients display what the API returns; a live
   total while a bill is being edited comes from `POST /billing/preview`. There is
   exactly one implementation of every billing rule, so the total a resident sees and
   the total filed for GST cannot differ by a paisa.

Rounding is half-up at 2 decimal places for anything presented or invoiced. Bankers'
rounding is wrong here — Indian statutory invoicing expects half-up, and a committee
comparing against a hand-built spreadsheet will treat a 1-paisa difference as a bug.
Intermediate values keep 4 decimal places; only the final amount is quantised.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Final

CURRENCY: Final = "INR"

#: Storage precision. Matches numeric(18,4) in Postgres.
STORAGE_EXPONENT: Final = Decimal("0.0001")

#: Presentation and invoicing precision — rupees and paise.
MONEY_EXPONENT: Final = Decimal("0.01")

ZERO: Final = Decimal("0.00")


class MoneyError(ValueError):
    """Raised when a value cannot be safely interpreted as money."""


def money(value: str | int | Decimal) -> Decimal:
    """Build a money value.

    `float` is rejected deliberately — accepting it would reintroduce the binary
    floating-point rounding errors this module exists to prevent.
    """
    if isinstance(value, float):
        raise MoneyError(
            "float is not accepted for money. Pass a str, int or Decimal "
            "(e.g. money('1250.50'), not money(1250.50))."
        )
    try:
        return Decimal(value).quantize(STORAGE_EXPONENT, rounding=ROUND_HALF_UP)
    except InvalidOperation as exc:
        raise MoneyError(f"Not a valid money value: {value!r}") from exc


def quantise(value: Decimal) -> Decimal:
    """Round to rupees and paise, half-up. Use for any presented or invoiced amount."""
    return value.quantize(MONEY_EXPONENT, rounding=ROUND_HALF_UP)


def apply_rate(base: Decimal, rate_percent: Decimal) -> Decimal:
    """Apply a percentage rate (GST, interest) and quantise the result.

    >>> apply_rate(Decimal("7500.00"), Decimal("18"))
    Decimal('1350.00')
    """
    return quantise(base * rate_percent / Decimal("100"))


def allocate(total: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Split `total` across `weights` without losing or inventing a paisa.

    Naive proportional splitting leaves a remainder that silently vanishes. This
    distributes the rounding remainder one paisa at a time to the largest shares
    first, so the parts always sum exactly to the whole — which is what makes a
    per-sq-ft maintenance split reconcile against the society's bank statement.

    >>> sum(allocate(Decimal("100.00"), [Decimal(1), Decimal(1), Decimal(1)]))
    Decimal('100.00')
    """
    if not weights:
        raise MoneyError("Cannot allocate across an empty set of weights.")

    weight_total = sum(weights, Decimal(0))
    if weight_total <= 0:
        raise MoneyError("Allocation weights must sum to a positive value.")

    raw = [total * w / weight_total for w in weights]
    parts = [quantise(r) for r in raw]

    remainder = quantise(total) - sum(parts, Decimal(0))
    if remainder == 0:
        return parts

    step = Decimal("0.01") if remainder > 0 else Decimal("-0.01")
    # Largest fractional loss gets corrected first — the conventional, defensible order.
    order = sorted(range(len(parts)), key=lambda i: raw[i] - parts[i], reverse=remainder > 0)

    for i in order[: int(abs(remainder) / Decimal("0.01"))]:
        parts[i] += step

    return parts
