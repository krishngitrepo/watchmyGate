/**
 * Tally export.
 *
 * ## Why this exists at all
 *
 * Import is what brings a society onto this platform. Export is what lets their
 * accountant keep working — and almost every society in India has an accountant who has
 * used Tally for twenty years and is not going to stop because the committee changed
 * software.
 *
 * Withholding it would be a lock-in tactic, and a transparent one: the first question a
 * chartered accountant asks in a demo is "can I get this into Tally". Answering no does
 * not trap anybody, it loses the deal in the room. So this produces a file Tally will
 * actually import, and it is a first-class feature rather than a grudging one.
 *
 * ## What it produces
 *
 * Tally's XML import envelope, carrying one journal voucher per posted entry, with a
 * ledger master for every account so a fresh Tally company accepts the file without the
 * accountant creating heads by hand first.
 *
 * The voucher date format is `YYYYMMDD` with no separators — Tally rejects anything else
 * silently, which is the worst possible failure mode because the import "succeeds" with
 * zero vouchers.
 */

import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { ValidationError } from "../../common/errors.js";
import { tx } from "../../common/tenant-context.js";

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] })?.rows ?? (result as T[])) ?? [];
}

/**
 * Escape for XML.
 *
 * A society named `Prestige & Co` or a narration containing `<` produces a file Tally
 * refuses to parse, and the error it gives names a byte offset rather than a cause. Five
 * entities, applied to every value that reaches the document.
 */
function xml(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Tally wants YYYYMMDD. Anything else imports as zero vouchers, silently. */
function tallyDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

/**
 * Our account types to Tally's primary groups.
 *
 * Deliberately conservative: everything lands in a group that exists in a default Tally
 * company, so the import does not depend on the accountant having created a chart that
 * matches ours. They can regroup afterwards; they cannot import into a group that is not
 * there.
 */
const GROUP_FOR: Record<string, string> = {
  asset: "Current Assets",
  liability: "Current Liabilities",
  income: "Indirect Incomes",
  expense: "Indirect Expenses",
  equity: "Capital Account",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface EntryRow {
  entryNumber: string;
  entryDate: string;
  narration: string;
  lines: { name: string; debit: string; credit: string }[];
}

@Injectable()
export class TallyService {
  /**
   * A Tally-importable XML document for a date range.
   *
   * Returns a string rather than streaming. A society's full year is a few thousand
   * vouchers — well under a megabyte — and streaming would buy nothing but complexity.
   */
  async exportXml(societyName: string, from: string, to: string): Promise<string> {
    if (!DATE.test(from) || !DATE.test(to)) {
      throw new ValidationError("Both dates must be YYYY-MM-DD.");
    }
    if (from > to) {
      throw new ValidationError("The period has to end after it starts.");
    }

    return tx(async (db) => {
      const accounts = rowsOf<{ name: string; type: string }>(
        await db.execute(sql`
          SELECT a.name, a.type::text AS type
          FROM ledger_accounts a
          ORDER BY a.code
        `),
      );

      const entries = rowsOf<EntryRow>(
        await db.execute(sql`
          SELECT
            e.entry_number     AS "entryNumber",
            e.entry_date::text AS "entryDate",
            e.narration,
            json_agg(
              json_build_object(
                'name', a.name,
                'debit', l.debit::text,
                'credit', l.credit::text
              )
              -- Debits first. Tally reads the first line as the primary voucher party,
              -- and a voucher that opens on a credit reads inside out to an accountant.
              ORDER BY l.debit DESC, l.id
            ) AS lines
          FROM journal_entries e
          JOIN journal_lines l ON l.journal_entry_id = e.id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN ${from} AND ${to}
          GROUP BY e.id, e.entry_number, e.entry_date, e.narration
          ORDER BY e.entry_date, e.entry_number
        `),
      );

      return this.render(societyName, accounts, entries);
    });
  }

  private render(
    societyName: string,
    accounts: { name: string; type: string }[],
    entries: EntryRow[],
  ): string {
    const company = xml(societyName);

    const masters = accounts
      .map(
        (a) => `      <LEDGER NAME="${xml(a.name)}" ACTION="Create">
        <NAME>${xml(a.name)}</NAME>
        <PARENT>${GROUP_FOR[a.type] ?? "Suspense A/c"}</PARENT>
        <ISDEEMEDPOSITIVE>${a.type === "asset" || a.type === "expense" ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      </LEDGER>`,
      )
      .join("\n");

    const vouchers = entries
      .map((entry) => {
        const lines = entry.lines
          .map((line) => {
            // Tally's sign convention: a debit is positive-deemed and carries a negative
            // amount. Getting this backwards produces a file that imports cleanly and is
            // wrong in every figure — the worst of both worlds.
            const isDebit = /[1-9]/.test(line.debit);
            const amount = isDebit ? `-${line.debit}` : line.credit;
            return `        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${xml(line.name)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${isDebit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
          <AMOUNT>${amount}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
          })
          .join("\n");

        return `      <VOUCHER VCHTYPE="Journal" ACTION="Create" OBJVIEW="Accounting Voucher View">
        <DATE>${tallyDate(entry.entryDate)}</DATE>
        <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${xml(entry.entryNumber)}</VOUCHERNUMBER>
        <NARRATION>${xml(entry.narration)}</NARRATION>
        <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>
${lines}
      </VOUCHER>`;
      })
      .join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
${masters}
${vouchers}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
  }

  /**
   * The same books as CSV.
   *
   * Not everyone runs Tally. A CA working in Excel, or a society moving to different
   * software entirely, needs the data in a form nothing can refuse — and an export that
   * only one vendor can read is barely an export.
   */
  async exportCsv(from: string, to: string): Promise<string> {
    if (!DATE.test(from) || !DATE.test(to)) {
      throw new ValidationError("Both dates must be YYYY-MM-DD.");
    }

    return tx(async (db) => {
      const rows = rowsOf<{
        entryDate: string;
        entryNumber: string;
        narration: string;
        code: string;
        name: string;
        debit: string;
        credit: string;
      }>(
        await db.execute(sql`
          SELECT
            e.entry_date::text AS "entryDate",
            e.entry_number     AS "entryNumber",
            e.narration,
            a.code,
            a.name,
            l.debit::text      AS debit,
            l.credit::text     AS credit
          FROM journal_lines l
          JOIN journal_entries e ON e.id = l.journal_entry_id
          JOIN ledger_accounts a ON a.id = l.account_id
          WHERE e.entry_date BETWEEN ${from} AND ${to}
          ORDER BY e.entry_date, e.entry_number, l.id
        `),
      );

      const header = "Date,Voucher,Narration,Account Code,Account,Debit,Credit";
      const body = rows
        .map((r) =>
          [
            r.entryDate,
            r.entryNumber,
            csv(r.narration),
            r.code,
            csv(r.name),
            r.debit,
            r.credit,
          ].join(","),
        )
        .join("\n");

      return `${header}\n${body}\n`;
    });
  }
}

/**
 * Quote a CSV field.
 *
 * A narration reading `Repairs, Tower B` splits into two columns without this, which
 * shifts every figure on that row one place left — and a spreadsheet that is wrong only
 * on the rows containing a comma is a spreadsheet nobody catches.
 */
function csv(value: string | null | undefined): string {
  const text = value ?? "";
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
