"""OCR — bank statements and meter readings.

The highest-value AI feature in the product, and the one with the clearest failure
mode: an accountant reconciling a bank statement by hand for 400 flats is the single
most tedious job in a society's month.

Three rules shape everything here, and none is about accuracy:

**Extraction never posts.** This module returns *candidates*. A human matches them to
invoices, and the ledger is written by the billing service as it always was. A model
that can move money is a model that will eventually move money wrongly, and there is no
version of "the AI reconciled it" that a treasurer can defend at an AGM.

**Confidence travels with every row.** A number the model was unsure about must arrive
labelled unsure, so the console can put it in front of a person rather than in a total.
Dropping confidence and returning a clean-looking list is how OCR output becomes trusted
more than it deserves.

**Amounts stay strings.** They cross into `numeric` untouched. A float here would put a
rounding error into a reconciliation, which is the one place nobody would look for it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from app.common.config import Settings

# Anthropic's vision models read a bank statement PDF far better than a classical OCR
# pipeline, because the hard part is not the glyphs — it is knowing which column is the
# credit and that the running balance is not a transaction.
OCR_MODEL = "claude-sonnet-4-5"

Confidence = Literal["high", "medium", "low"]


@dataclass(frozen=True)
class StatementLine:
    """One candidate transaction. Never posted automatically."""

    value_date: str
    description: str
    amount: str
    direction: Literal["credit", "debit"]
    reference: str | None = None
    confidence: Confidence = "medium"

    def as_dict(self) -> dict[str, Any]:
        return {
            "valueDate": self.value_date,
            "description": self.description,
            "amount": self.amount,
            "direction": self.direction,
            "reference": self.reference,
            "confidence": self.confidence,
        }


@dataclass
class ExtractionResult:
    lines: list[StatementLine] = field(default_factory=list)
    stubbed: bool = False
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "lines": [line.as_dict() for line in self.lines],
            "stubbed": self.stubbed,
            "warnings": self.warnings,
            # Stated rather than implied. Every consumer of this payload should be
            # reminded that nothing here has touched the ledger.
            "posted": False,
        }


_AMOUNT = re.compile(r"^-?\d+(\.\d{1,4})?$")


def normalise_amount(raw: str) -> str | None:
    """Clean a money string without ever making it a float.

    `Decimal` is used only to *validate* — the string that comes back is the cleaned
    input, not a re-rendered Decimal, so trailing zeros and the bank's own precision
    survive exactly as printed on the statement.
    """
    cleaned = raw.replace("₹", "").replace(",", "").replace(" ", "").strip()
    cleaned = cleaned.removesuffix("Cr").removesuffix("Dr").strip()
    if not _AMOUNT.match(cleaned):
        return None
    try:
        Decimal(cleaned)
    except InvalidOperation:
        return None
    return cleaned


def _prompt() -> str:
    """The extraction instruction.

    Explicit about the two things models get wrong on Indian bank statements: treating
    the running balance as a transaction, and losing the credit/debit distinction when a
    statement uses a single signed column.
    """
    return (
        "Extract every transaction from this bank statement.\n\n"
        "Rules:\n"
        "- The running balance column is NOT a transaction. Never emit it as one.\n"
        "- Indian statements may use one signed amount column or separate credit and "
        "debit columns. Normalise to an unsigned `amount` plus a `direction`.\n"
        "- Keep amounts exactly as printed, without currency symbols or thousands "
        "separators. Do not round.\n"
        "- Dates as YYYY-MM-DD.\n"
        "- If a row is unclear, still emit it with confidence 'low' rather than "
        "dropping it. A missing transaction is worse than an uncertain one, because "
        "nobody goes looking for what is not there.\n\n"
        'Return JSON: {"lines": [{"valueDate", "description", "amount", '
        '"direction", "reference", "confidence"}]}'
    )


def _stub_result() -> ExtractionResult:
    """What the module returns with no API key.

    Deliberately obvious rather than realistic. A stub that looked like a real statement
    could be mistaken for one in a screenshot or a demo; this cannot.
    """
    return ExtractionResult(
        lines=[
            StatementLine(
                value_date="2026-08-01",
                description="STUB — no Anthropic key configured",
                amount="0.00",
                direction="credit",
                confidence="low",
            )
        ],
        stubbed=True,
        warnings=["OCR is stubbed. Set ANTHROPIC_API_KEY to extract real statements."],
    )


def parse_model_response(payload: str) -> ExtractionResult:
    """Turn the model's JSON into validated lines.

    Every field is checked. A model returning a malformed amount, an unknown direction
    or a missing date produces a *warning and a dropped row*, never an exception — one
    bad row in a 200-line statement must not lose the other 199, which is the same rule
    the import tooling follows for the same reason.
    """
    result = ExtractionResult()

    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        result.warnings.append("The model did not return usable JSON.")
        return result

    raw_lines = data.get("lines") if isinstance(data, dict) else None
    if not isinstance(raw_lines, list):
        result.warnings.append("The model returned no transaction list.")
        return result

    for index, row in enumerate(raw_lines, start=1):
        if not isinstance(row, dict):
            result.warnings.append(f"Row {index}: not an object.")
            continue

        amount = normalise_amount(str(row.get("amount", "")))
        if amount is None:
            result.warnings.append(f"Row {index}: unreadable amount, dropped.")
            continue

        direction = row.get("direction")
        if direction not in ("credit", "debit"):
            result.warnings.append(f"Row {index}: unknown direction, dropped.")
            continue

        date = str(row.get("valueDate", ""))
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
            result.warnings.append(f"Row {index}: unreadable date, dropped.")
            continue

        confidence = row.get("confidence")
        if confidence not in ("high", "medium", "low"):
            # An unlabelled row is treated as uncertain rather than trusted. The safe
            # default is the one that puts it in front of a person.
            confidence = "low"

        result.lines.append(
            StatementLine(
                value_date=date,
                description=str(row.get("description", "")).strip()[:500],
                amount=amount,
                direction=direction,
                reference=(str(row["reference"])[:120] if row.get("reference") else None),
                confidence=confidence,
            )
        )

    return result


async def extract_statement(pdf_bytes: bytes, settings: Settings) -> ExtractionResult:
    """Read a bank statement.

    Returns candidates only. Reconciliation — matching these to invoices and writing
    receipts — happens in the TypeScript billing service, against the same ledger rules
    as a manually entered payment.
    """
    if settings.ocr_is_stubbed:
        return _stub_result()

    import httpx  # imported lazily so the stub path needs no network stack at all

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.anthropic_api_key.get_secret_value(),
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": OCR_MODEL,
                "max_tokens": 8192,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "document",
                                "source": {
                                    "type": "base64",
                                    "media_type": "application/pdf",
                                    "data": _b64(pdf_bytes),
                                },
                            },
                            {"type": "text", "text": _prompt()},
                        ],
                    }
                ],
            },
        )
        response.raise_for_status()
        body = response.json()

    text = "".join(
        block.get("text", "") for block in body.get("content", []) if isinstance(block, dict)
    )
    return parse_model_response(text)


def _b64(data: bytes) -> str:
    import base64

    return base64.standard_b64encode(data).decode("ascii")
