"""Money arithmetic.

The ledger is the highest-risk code in this product: a rounding bug does not crash, it
quietly bills a society wrong and is discovered at the annual audit.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from app.common.money import MoneyError, allocate, apply_rate, money, quantise


def test_float_is_rejected() -> None:
    """Accepting float would reintroduce binary rounding error.

    0.1 + 0.2 != 0.3 in binary floating point. Blocking float at the boundary is what
    makes the rest of the money code trustworthy.
    """
    with pytest.raises(MoneyError, match="float is not accepted"):
        money(1250.50)  # type: ignore[arg-type]


def test_string_and_decimal_accepted() -> None:
    assert money("1250.50") == Decimal("1250.5000")
    assert money(Decimal("1250.50")) == Decimal("1250.5000")
    assert money(1250) == Decimal("1250.0000")


def test_rounding_is_half_up_not_bankers() -> None:
    """Indian statutory invoicing expects half-up.

    Python's default is banker's rounding, which would round 0.125 to 0.12 and cause a
    committee comparing against a spreadsheet to report a bug.
    """
    assert quantise(Decimal("0.125")) == Decimal("0.13")
    assert quantise(Decimal("0.135")) == Decimal("0.14")


def test_gst_calculation() -> None:
    assert apply_rate(Decimal("7500.00"), Decimal("18")) == Decimal("1350.00")
    assert apply_rate(Decimal("2350.75"), Decimal("18")) == Decimal("423.14")


@pytest.mark.parametrize(
    ("total", "weights"),
    [
        ("100.00", [1, 1, 1]),  # classic 33.33 x3 remainder
        ("1000.00", [1150, 980, 1340]),  # per-sq-ft split
        ("0.05", [1, 1, 1, 1, 1, 1]),  # fewer paise than shares
        ("12345.67", [7, 3]),
    ],
)
def test_allocation_never_loses_a_paisa(total: str, weights: list[int]) -> None:
    """The sum of the parts must equal the whole, exactly.

    Naive proportional splitting drops the rounding remainder, and a maintenance bill
    that does not reconcile against the society's bank statement destroys trust in
    month one.
    """
    amount = Decimal(total)
    parts = allocate(amount, [Decimal(w) for w in weights])
    assert sum(parts, Decimal(0)) == quantise(amount)
    assert len(parts) == len(weights)


def test_allocation_rejects_empty_and_zero_weights() -> None:
    with pytest.raises(MoneyError):
        allocate(Decimal("100"), [])
    with pytest.raises(MoneyError):
        allocate(Decimal("100"), [Decimal(0), Decimal(0)])
