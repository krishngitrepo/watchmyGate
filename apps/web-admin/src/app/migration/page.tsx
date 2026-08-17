"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Banner,
  Chip,
  Field,
  Figure,
  Ledger,
  Loading,
  Problem,
  Shell,
  Tabs,
  useAction,
} from "../../components/Shell";
import { api } from "../../lib/api";

interface State {
  towers: number;
  units: number;
  occupancies: number;
  invoices: number;
  openingBalances: number;
}

interface RowResult {
  row: number;
  outcome: string;
  reason?: string;
  ref?: string;
}

interface ImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  rejected: number;
  results: RowResult[];
}

type Kind = "units" | "balances";

/**
 * Column names people actually use.
 *
 * A society exporting from Tally, from a competitor, or from the spreadsheet the
 * secretary has kept since 2019 will not use our field names, and asking them to rename
 * columns before importing is where migrations get abandoned. Matching is done on the
 * header with spacing, case and punctuation stripped.
 */
const UNIT_COLUMNS: Record<string, string[]> = {
  tower: ["tower", "block", "wing", "building", "towerblock"],
  number: ["number", "flat", "flatno", "flatnumber", "unit", "unitno", "door", "doorno"],
  floor: ["floor", "flr", "level"],
  carpetAreaSqft: ["carpetarea", "carpetareasqft", "area", "sqft", "sqfeet", "builtuparea"],
  bhk: ["bhk", "type", "flattype", "configuration"],
  ownerName: ["ownername", "owner", "ownersname", "primaryowner"],
  ownerPhone: ["ownerphone", "ownermobile", "ownercontact", "phone", "mobile", "contact"],
  tenantName: ["tenantname", "tenant", "occupant", "occupantname"],
  tenantPhone: ["tenantphone", "tenantmobile", "tenantcontact"],
};

const BALANCE_COLUMNS: Record<string, string[]> = {
  unitNumber: ["unitnumber", "flat", "flatno", "flatnumber", "unit", "unitno"],
  amount: ["amount", "balance", "openingbalance", "dues", "outstanding", "arrears"],
  asOf: ["asof", "asondate", "date", "asatdate", "balancedate"],
  note: ["note", "remarks", "narration", "description"],
};

const NUMERIC_FIELDS = new Set(["floor", "bhk"]);

/**
 * Import a society's register.
 *
 * This screen is the product's moat and it is worth being explicit about why: a 400-flat
 * society will not retype its register, so migration quality — not feature count —
 * decides whether a society actually moves. Everything here is arranged around that.
 *
 * **Preview is not optional.** `dryRun` defaults to true on the API too, the opposite of
 * the usual convention, so that forgetting the flag previews rather than writing 400
 * flats into a live society.
 *
 * **Every row is reported individually.** A bad row is rejected with a reason and the
 * other 399 still land — an import that aborts on row 12 is an import nobody finishes.
 *
 * **Running it twice is safe.** A flat that already exists is skipped, not duplicated, so
 * the natural response to a half-finished import ("just run it again") is the correct one.
 */
export default function MigrationPage() {
  const [kind, setKind] = useState<Kind>("units");
  const [state, setState] = useState<State | null>(null);
  const [raw, setRaw] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const action = useAction();

  const loadState = useCallback(async () => {
    try {
      setState(await api.get<State>("/v1/migration/state"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const parsed = useMemo(
    () => parseSheet(raw, kind === "units" ? UNIT_COLUMNS : BALANCE_COLUMNS),
    [raw, kind],
  );

  const path = kind === "units" ? "/v1/migration/units" : "/v1/migration/opening-balances";

  function run(commit: boolean) {
    void action.run(async () => {
      const result = await api.post<ImportReport>(
        `${path}${commit ? "?commit=true" : ""}`,
        { rows: parsed.rows },
      );
      setReport(result);
      if (commit) await loadState();
    });
  }

  const previewClean =
    report !== null && report.dryRun && report.rejected === 0 && report.total > 0;

  return (
    <Shell
      title="Import Data"
      lede="Bring a society's register across from Tally, a spreadsheet, or another app."
    >
      {error ? <Problem error={error} /> : null}
      {loading ? <Loading /> : null}

      {state ? (
        <dl className="figures settle">
          <Figure label="Towers" value={String(state.towers)} />
          <Figure label="Flats" value={String(state.units)} />
          <Figure label="Residents" value={String(state.occupancies)} hint="occupancy records" />
          <Figure label="Invoices" value={String(state.invoices)} />
          <Figure
            label="Opening balances"
            value={String(state.openingBalances)}
            hint="carried in"
          />
        </dl>
      ) : null}

      <section className="ledger settle">
        <Tabs
          tabs={[
            { id: "units" as const, label: "Flats & residents" },
            { id: "balances" as const, label: "Opening balances" },
          ]}
          active={kind}
          onChange={(next) => {
            setKind(next);
            setRaw("");
            setReport(null);
            action.reset();
          }}
        />

        <div className="steps">
          <span className="step" data-active={raw.trim() ? "false" : "true"}>
            <span className="step-num">1</span> Paste
          </span>
          <span className="step-arrow">→</span>
          <span className="step" data-active={raw.trim() && !previewClean ? "true" : "false"}>
            <span className="step-num">2</span> Preview
          </span>
          <span className="step-arrow">→</span>
          <span className="step" data-active={previewClean ? "true" : "false"}>
            <span className="step-num">3</span> Commit
          </span>
        </div>

        <div className="card-body">
          {kind === "units" ? (
            <Banner tone="info">
              Paste the sheet including its header row. Columns are matched by name —{" "}
              <strong>Flat No</strong>, <strong>Block</strong>, <strong>Owner Name</strong>{" "}
              and the rest are all recognised, so nothing needs renaming first. Tab-separated
              (straight out of Excel) or comma-separated both work.
            </Banner>
          ) : (
            <Banner tone="info">
              One row per flat with the amount it owed on the changeover date. Balances land
              as invoices marked <strong>OPEN-</strong>, so the arrears a resident sees on
              day one match what the old system said to the paisa — and the ledger still
              balances.
            </Banner>
          )}

          <Field
            label={kind === "units" ? "Flat register" : "Opening balances"}
            htmlFor="sheet"
            hint={
              parsed.error
                ? parsed.error
                : parsed.rows.length > 0
                  ? `${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"} read · columns matched: ${parsed.matched.join(", ")}`
                  : kind === "units"
                    ? "Tower, Flat No, Floor, Carpet Area, BHK, Owner Name, Owner Phone…"
                    : "Flat No, Amount, As Of Date, Remarks"
            }
          >
            <textarea
              id="sheet"
              value={raw}
              onChange={(e) => {
                setRaw(e.target.value);
                setReport(null);
              }}
              placeholder={
                kind === "units"
                  ? "Tower\tFlat No\tFloor\tCarpet Area\tBHK\tOwner Name\tOwner Phone\nA\tA-101\t1\t1150\t2\tR Sharma\t+919900000001"
                  : "Flat No,Amount,As Of\nA-101,4500.00,2026-04-01"
              }
              style={{
                minHeight: 190,
                fontFamily: "var(--font-figure)",
                fontSize: "0.78rem",
                whiteSpace: "pre",
                overflowX: "auto",
              }}
            />
          </Field>

          {parsed.unmatched.length > 0 ? (
            <Banner tone="warn">
              Ignored columns: {parsed.unmatched.join(", ")}. Nothing is lost — they simply
              have no home in this import, and the rows still load.
            </Banner>
          ) : null}

          {action.error ? <Banner tone="error">{action.error}</Banner> : null}

          <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginTop: 4 }}>
            <button
              disabled={action.busy || parsed.rows.length === 0}
              onClick={() => run(false)}
            >
              {action.busy && !report ? "Checking…" : "Preview"}
            </button>
            <button
              data-variant={previewClean ? "primary" : undefined}
              disabled={action.busy || !previewClean}
              title={
                previewClean
                  ? undefined
                  : "Preview first, and clear any rejected rows before committing."
              }
              onClick={() => run(true)}
            >
              {action.busy && report ? "Importing…" : `Commit ${parsed.rows.length} rows`}
            </button>
          </div>
        </div>
      </section>

      {report ? (
        <>
          <Banner tone={report.dryRun ? "warn" : "ok"}>
            {report.dryRun ? (
              <>
                <strong>Nothing was written.</strong> This is what would happen: {report.created}{" "}
                created, {report.updated} updated, {report.skipped} already present,{" "}
                {report.rejected} rejected.
              </>
            ) : (
              <>
                <strong>Imported.</strong> {report.created} created, {report.updated} updated,{" "}
                {report.skipped} already present, {report.rejected} rejected.
              </>
            )}
          </Banner>

          <Ledger
            title={report.dryRun ? "What would happen, row by row" : "What happened, row by row"}
            note={`${report.total} rows`}
            head={["~Row", "Reference", "Outcome", "Reason"]}
            empty="No rows."
            isEmpty={report.results.length === 0}
          >
            {report.results.map((row) => (
              <tr key={`${row.row}-${row.ref ?? ""}`}>
                <td className="num muted">{row.row}</td>
                <td className="strong">{row.ref ?? "—"}</td>
                <td>
                  <Chip
                    tone={
                      row.outcome === "reject"
                        ? "arrears"
                        : row.outcome === "skip"
                          ? "quiet"
                          : "settled"
                    }
                  >
                    {row.outcome}
                  </Chip>
                </td>
                <td className="muted">{row.reason ?? "—"}</td>
              </tr>
            ))}
          </Ledger>
        </>
      ) : null}

      <section className="card settle">
        <div className="card-head">
          <h2>What makes this safe to run</h2>
        </div>
        <div className="card-body">
          <p>
            <strong>Preview writes nothing.</strong> The flag that commits has to be set
            explicitly — forgetting it previews. That is the opposite of the usual
            convention, and deliberately so: the cost of a mistaken preview is nothing, and
            the cost of a mistaken import is a live society&apos;s register.
          </p>
          <p>
            <strong>Running it twice is safe.</strong> A flat that already exists is skipped
            rather than duplicated, so the natural response to a half-finished import — run
            it again — is also the correct one.
          </p>
          <p>
            <strong>Amounts stay exact.</strong> An opening balance is carried across as a
            decimal string and never passes through a floating-point number, so the arrears
            a resident sees on day one match the old system to the paisa. A migration that
            is off by a rupee is a migration a committee will not sign off.
          </p>
        </div>
      </section>
    </Shell>
  );
}

// ----------------------------------------------------------------- parsing

interface Parsed {
  rows: Record<string, string | number>[];
  matched: string[];
  unmatched: string[];
  error: string;
}

/**
 * Read a pasted sheet.
 *
 * Tabs are tried before commas because pasting straight out of Excel produces tabs, and
 * a rupee amount written as "1,23,456.00" would otherwise split into three columns and
 * corrupt every row silently — the worst possible failure for an import.
 */
function parseSheet(raw: string, columns: Record<string, string[]>): Parsed {
  const text = raw.trim();
  if (!text) return { rows: [], matched: [], unmatched: [], error: "" };

  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return {
      rows: [],
      matched: [],
      unmatched: [],
      error: "Include the header row, then at least one row of data.",
    };
  }

  const delimiter = lines[0]!.includes("\t") ? "\t" : ",";
  const headers = splitRow(lines[0]!, delimiter);

  const mapping = new Map<number, string>();
  const unmatched: string[] = [];

  headers.forEach((header, index) => {
    const key = normaliseHeader(header);
    const field = Object.entries(columns).find(([, aliases]) => aliases.includes(key))?.[0];
    if (field) mapping.set(index, field);
    else if (header.trim()) unmatched.push(header.trim());
  });

  const matched = [...new Set(mapping.values())];
  if (matched.length === 0) {
    return {
      rows: [],
      matched: [],
      unmatched,
      error: `No columns recognised. Expected at least ${Object.keys(columns).slice(0, 2).join(" and ")}.`,
    };
  }

  const rows: Record<string, string | number>[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitRow(line, delimiter);
    const row: Record<string, string | number> = {};

    for (const [index, field] of mapping) {
      const value = (cells[index] ?? "").trim();
      if (!value) continue;

      if (NUMERIC_FIELDS.has(field)) {
        const n = Number(value.replace(/\D/g, ""));
        if (Number.isFinite(n) && n !== 0) row[field] = n;
        continue;
      }

      if (field === "carpetAreaSqft" || field === "amount") {
        // Strip grouping and the rupee sign, but keep it a **string**. This is the one
        // place a float could enter the money path through an import.
        const cleaned = value.replace(/[₹,\s]/g, "");
        if (/^-?\d+(\.\d+)?$/.test(cleaned)) row[field] = cleaned;
        continue;
      }

      row[field] = value;
    }

    if (Object.keys(row).length > 0) rows.push(row);
  }

  return { rows: rows.slice(0, 5000), matched, unmatched, error: "" };
}

/** Split one line, respecting double quotes so `"Sharma, R"` stays a single cell. */
function splitRow(line: string, delimiter: string): string[] {
  if (delimiter === "\t") return line.split("\t");

  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      // A doubled quote inside a quoted cell is a literal quote.
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}
