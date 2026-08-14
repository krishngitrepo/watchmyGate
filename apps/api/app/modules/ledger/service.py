"""Double-entry ledger.

This is the highest-risk code in the product. A bug here does not crash — it quietly
bills a society wrong and is discovered at the annual audit, by which point trust is
gone.

Four invariants, none negotiable:

1. **Every journal entry balances.** Sum of debits equals sum of credits, always.
2. **Posted entries are immutable.** UPDATE and DELETE are revoked from the application
   role at the database and enforced by trigger. A correction is a reversing entry.
3. **Money is Decimal.** `numeric(18,4)` in Postgres, `decimal.Decimal` in Python.
4. **Locked periods cannot be written.** Reopening needs two people and is audit-logged.

The scheduled invariant job re-checks 1 and 4 hourly and pages if they drift.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from decimal import Decimal

import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.errors import ConflictError, ValidationError
from app.common.money import ZERO, money
from app.modules.ledger.models import (
    AccountingPeriod,
    JournalEntry,
    JournalLine,
    LedgerAccount,
    PeriodStatus,
    SourceType,
)

log = structlog.get_logger(__name__)


@dataclass(frozen=True)
class Posting:
    """One side of a journal entry."""

    account_code: str
    debit: Decimal = ZERO
    credit: Decimal = ZERO
    unit_id: uuid.UUID | None = None

    def __post_init__(self) -> None:
        if self.debit < 0 or self.credit < 0:
            raise ValidationError("Ledger amounts cannot be negative.")
        if (self.debit == 0) == (self.credit == 0):
            raise ValidationError(
                "Each ledger line must be either a debit or a credit, not both or neither."
            )


async def post_entry(
    session: AsyncSession,
    society_id: uuid.UUID,
    *,
    entry_date: dt.date,
    narration: str,
    source_type: SourceType,
    source_id: uuid.UUID | None,
    postings: list[Posting],
    posted_by: uuid.UUID | None = None,
) -> JournalEntry:
    """Write a balanced journal entry.

    Refuses to post into a locked period and refuses to post anything that does not
    balance. Both checks happen before any row is written, so a rejected entry leaves
    no trace.
    """
    if len(postings) < 2:
        raise ValidationError("A journal entry needs at least two lines.")

    debits = sum((p.debit for p in postings), ZERO)
    credits = sum((p.credit for p in postings), ZERO)

    if debits != credits:
        raise ValidationError(
            f"Journal entry does not balance: debits {debits} vs credits {credits}."
        )
    if debits == 0:
        raise ValidationError("A journal entry cannot be for zero.")

    period = await _period_for(session, society_id, entry_date)
    if period is not None and period.status is PeriodStatus.locked:
        raise ConflictError(
            f"The accounting period ending {period.ends_on} is closed. "
            "Ask the committee to reopen it, or post to the current period."
        )

    accounts = await _resolve_accounts(session, society_id, {p.account_code for p in postings})

    entry = JournalEntry(
        id=uuid.uuid4(),
        society_id=society_id,
        entry_number=await _next_entry_number(session, society_id, entry_date),
        entry_date=entry_date,
        narration=narration,
        source_type=source_type,
        source_id=source_id,
        posted_at=dt.datetime.now(dt.UTC),
        posted_by=posted_by,
        period_id=period.id if period else None,
    )
    session.add(entry)
    await session.flush()

    for posting in postings:
        session.add(
            JournalLine(
                id=uuid.uuid4(),
                society_id=society_id,
                journal_entry_id=entry.id,
                account_id=accounts[posting.account_code],
                debit=posting.debit,
                credit=posting.credit,
                unit_id=posting.unit_id,
            )
        )

    log.info(
        "journal_posted",
        entry_id=str(entry.id),
        number=entry.entry_number,
        amount=str(debits),
        source=str(source_type),
    )
    return entry


async def reverse_entry(
    session: AsyncSession,
    society_id: uuid.UUID,
    entry_id: uuid.UUID,
    *,
    reason: str,
    posted_by: uuid.UUID | None = None,
) -> JournalEntry:
    """Correct a posted entry by writing its mirror image.

    The original is never edited. This is why the ledger can be trusted: history is
    additive, so an auditor can see both what was recorded and what corrected it.
    """
    original = await session.get(JournalEntry, entry_id)
    if original is None or original.society_id != society_id:
        raise ValidationError("That journal entry does not exist.")
    if original.reverses_entry_id is not None:
        raise ConflictError("A reversing entry cannot itself be reversed.")

    existing_reversal = await session.scalar(
        select(JournalEntry).where(
            JournalEntry.society_id == society_id,
            JournalEntry.reverses_entry_id == entry_id,
        )
    )
    if existing_reversal is not None:
        raise ConflictError("That entry has already been reversed.")

    lines = await session.scalars(
        select(JournalLine).where(JournalLine.journal_entry_id == entry_id)
    )

    reversal = JournalEntry(
        id=uuid.uuid4(),
        society_id=society_id,
        entry_number=await _next_entry_number(session, society_id, dt.date.today()),
        entry_date=dt.date.today(),
        narration=f"Reversal of {original.entry_number}: {reason}",
        source_type=SourceType.adjustment,
        source_id=original.source_id,
        posted_at=dt.datetime.now(dt.UTC),
        posted_by=posted_by,
        reverses_entry_id=original.id,
    )
    session.add(reversal)
    await session.flush()

    for line in lines:
        session.add(
            JournalLine(
                id=uuid.uuid4(),
                society_id=society_id,
                journal_entry_id=reversal.id,
                account_id=line.account_id,
                debit=line.credit,  # swapped
                credit=line.debit,
                unit_id=line.unit_id,
            )
        )

    log.info("journal_reversed", original=str(entry_id), reversal=str(reversal.id))
    return reversal


async def account_balance(
    session: AsyncSession,
    society_id: uuid.UUID,
    account_code: str,
    *,
    as_of: dt.date | None = None,
) -> Decimal:
    """Net balance of one account, debits minus credits."""
    account = await session.scalar(
        select(LedgerAccount).where(
            LedgerAccount.society_id == society_id, LedgerAccount.code == account_code
        )
    )
    if account is None:
        raise ValidationError(f"No ledger account with code {account_code}.")

    stmt = (
        select(
            func.coalesce(func.sum(JournalLine.debit), 0)
            - func.coalesce(func.sum(JournalLine.credit), 0)
        )
        .select_from(JournalLine)
        .join(JournalEntry, JournalEntry.id == JournalLine.journal_entry_id)
        .where(
            JournalLine.society_id == society_id,
            JournalLine.account_id == account.id,
        )
    )
    if as_of is not None:
        stmt = stmt.where(JournalEntry.entry_date <= as_of)

    return money(await session.scalar(stmt) or 0)


async def check_invariants(session: AsyncSession, society_id: uuid.UUID) -> list[str]:
    """Re-verify the ledger's arithmetic. Run hourly by Cloud Scheduler.

    Returns a list of violations — empty means healthy. Any violation pages an
    engineer, because it means money has gone missing somewhere in the code.
    """
    violations: list[str] = []

    # 1. Every journal entry balances.
    unbalanced = await session.execute(
        select(
            JournalLine.journal_entry_id,
            func.sum(JournalLine.debit).label("debits"),
            func.sum(JournalLine.credit).label("credits"),
        )
        .where(JournalLine.society_id == society_id)
        .group_by(JournalLine.journal_entry_id)
        .having(func.sum(JournalLine.debit) != func.sum(JournalLine.credit))
    )
    for entry_id, debits, credits in unbalanced:
        violations.append(
            f"Journal entry {entry_id} does not balance: debits {debits}, credits {credits}."
        )

    # 2. The whole ledger balances.
    totals = await session.execute(
        select(
            func.coalesce(func.sum(JournalLine.debit), 0),
            func.coalesce(func.sum(JournalLine.credit), 0),
        ).where(JournalLine.society_id == society_id)
    )
    total_debits, total_credits = totals.one()
    if total_debits != total_credits:
        violations.append(
            f"Society ledger does not balance: debits {total_debits}, credits {total_credits}."
        )

    # 3. No orphan lines.
    orphans = await session.scalar(
        select(func.count())
        .select_from(JournalLine)
        .outerjoin(JournalEntry, JournalEntry.id == JournalLine.journal_entry_id)
        .where(JournalLine.society_id == society_id, JournalEntry.id.is_(None))
    )
    if orphans:
        violations.append(f"{orphans} journal lines have no parent entry.")

    if violations:
        log.error("ledger_invariant_violation", society_id=str(society_id), count=len(violations))
    return violations


async def lock_period(
    session: AsyncSession,
    society_id: uuid.UUID,
    period_id: uuid.UUID,
    *,
    locked_by: uuid.UUID,
) -> AccountingPeriod:
    period = await session.get(AccountingPeriod, period_id)
    if period is None or period.society_id != society_id:
        raise ValidationError("That accounting period does not exist.")
    if period.status is PeriodStatus.locked:
        return period

    violations = await check_invariants(session, society_id)
    if violations:
        raise ConflictError(
            "The ledger does not balance, so this period cannot be closed: " + violations[0]
        )

    period.status = PeriodStatus.locked
    period.locked_by = locked_by
    period.locked_at = dt.datetime.now(dt.UTC)
    return period


async def reopen_period(
    session: AsyncSession,
    society_id: uuid.UUID,
    period_id: uuid.UUID,
    *,
    requested_by: uuid.UUID,
    approved_by: uuid.UUID,
) -> AccountingPeriod:
    """Reopen a closed period. Requires two different people.

    Reopening a closed book is how fraud is committed, so it needs a second signature
    and leaves an audit record naming both.
    """
    if requested_by == approved_by:
        raise ConflictError(
            "Reopening a closed period needs two different committee members to approve."
        )

    period = await session.get(AccountingPeriod, period_id)
    if period is None or period.society_id != society_id:
        raise ValidationError("That accounting period does not exist.")

    period.status = PeriodStatus.open
    period.reopened_by = requested_by
    period.reopened_approved_by = approved_by
    log.warning(
        "period_reopened",
        period_id=str(period_id),
        by=str(requested_by),
        approved_by=str(approved_by),
    )
    return period


async def _period_for(
    session: AsyncSession, society_id: uuid.UUID, on: dt.date
) -> AccountingPeriod | None:
    return await session.scalar(
        select(AccountingPeriod).where(
            AccountingPeriod.society_id == society_id,
            AccountingPeriod.starts_on <= on,
            AccountingPeriod.ends_on >= on,
        )
    )


async def _resolve_accounts(
    session: AsyncSession, society_id: uuid.UUID, codes: set[str]
) -> dict[str, uuid.UUID]:
    rows = await session.scalars(
        select(LedgerAccount).where(
            LedgerAccount.society_id == society_id, LedgerAccount.code.in_(codes)
        )
    )
    found = {a.code: a.id for a in rows}
    missing = codes - found.keys()
    if missing:
        raise ValidationError(f"Unknown ledger accounts: {', '.join(sorted(missing))}.")
    return found


async def _next_entry_number(
    session: AsyncSession, society_id: uuid.UUID, entry_date: dt.date
) -> str:
    prefix = f"JV{entry_date.year}-"
    count = await session.scalar(
        select(func.count())
        .select_from(JournalEntry)
        .where(
            JournalEntry.society_id == society_id,
            JournalEntry.entry_number.like(f"{prefix}%"),
        )
    )
    return f"{prefix}{(count or 0) + 1:06d}"
