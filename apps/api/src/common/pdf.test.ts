/**
 * The PDF writer.
 *
 * The assertion that matters is the cross-reference table: a viewer reads it first, and
 * an offset that is wrong by one byte makes the whole document unopenable while every
 * other test in this file still passes. So `walkXref` parses the table back out and
 * checks that every offset lands exactly on its own object header.
 */

import { describe, expect, it } from "vitest";

import { PAGE_HEIGHT, PAGE_WIDTH, Pdf, textWidth } from "./pdf.js";

const FIXED = new Date("2026-04-01T06:30:00Z");

/** Read the xref back and return, per object, whether its offset is right. */
function walkXref(bytes: Buffer): { count: number; allOffsetsCorrect: boolean } {
  const text = bytes.toString("latin1");
  const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
  const header = /^xref\s+0 (\d+)\s*$/m.exec(text.slice(startxref, startxref + 40));
  const count = Number(header?.[1]);

  // The table begins after "xref\n0 N\n"; entry 0 is the free head, then 20 bytes each.
  const tableStart = text.indexOf("\n", text.indexOf("\n", startxref) + 1) + 1;
  let allOffsetsCorrect = true;
  for (let number = 1; number < count; number += 1) {
    // Entry 0 is the free head, so object N's entry starts at N * 20.
    const entry = text.slice(tableStart + number * 20, tableStart + (number + 1) * 20);
    const offset = Number(entry.slice(0, 10));
    if (!text.startsWith(`${number} 0 obj`, offset)) allOffsetsCorrect = false;
  }
  return { count, allOffsetsCorrect };
}

describe("the file a viewer will accept", () => {
  it("is a PDF, and says so at both ends", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("Hello", 40, 40);
    const bytes = doc.build();

    expect(bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(bytes.subarray(-6).toString("latin1")).toBe("%%EOF\n");
  });

  it("declares itself binary on the second line", () => {
    // Without this comment some transfer paths convert line endings and corrupt streams.
    const bytes = new Pdf({ createdAt: FIXED }).build();
    expect(Array.from(bytes.subarray(9, 14))).toEqual([0x25, 0xe2, 0xe3, 0xcf, 0xd3]);
  });

  it("has a cross-reference table whose every offset is right", () => {
    const doc = new Pdf({ createdAt: FIXED, title: "Invoice INV-1" });
    doc.text("One", 40, 40);
    doc.rect(40, 60, 200, 20, [0.9, 0.9, 0.9]);
    doc.line(40, 100, 500, 100);

    const { count, allOffsetsCorrect } = walkXref(doc.build());
    expect(count).toBe(9); // catalog, pages, info, 3 fonts, 1 page + 1 content, +1 for slot 0
    expect(allOffsetsCorrect).toBe(true);
  });

  it("keeps every offset right across several pages", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("Page one", 40, 40);
    doc.newPage();
    doc.text("Page two", 40, 40);
    doc.newPage();
    doc.text("Page three", 40, 40);

    expect(doc.pageCount).toBe(3);
    const { count, allOffsetsCorrect } = walkXref(doc.build());
    expect(count).toBe(13); // 6 fixed + 3 pages x 2 + slot 0
    expect(allOffsetsCorrect).toBe(true);
  });

  it("declares a stream length that matches the bytes it wrote", () => {
    // A /Length that disagrees with the stream is the other way to make an unopenable
    // file, and it is exactly what a naive `.length` on a string with escapes produces.
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("Charges (annual) \\ balance", 40, 40);
    const text = doc.build().toString("latin1");

    const declared = Number(/<< \/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
    const body = text.slice(
      text.indexOf("stream\n") + "stream\n".length,
      text.indexOf("\nendstream"),
    );
    expect(body.length).toBe(declared);
  });
});

describe("text that would otherwise break the file", () => {
  it("escapes the characters that end a PDF string early", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("Maintenance (Apr) \\ Tower B", 40, 40);
    const text = doc.build().toString("latin1");
    expect(text).toContain("(Maintenance \\(Apr\\) \\\\ Tower B)");
  });

  it("rewrites the rupee sign, which Helvetica cannot draw", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("₹14,280.00", 40, 40);
    const text = doc.build().toString("latin1");
    expect(text).toContain("(Rs.14,280.00)");
    expect(text).not.toContain("₹");
  });

  it("replaces an unrenderable script visibly rather than dropping it", () => {
    // Silence would let a description vanish from an invoice unnoticed.
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("ನೀರು", 40, 40);
    expect(doc.build().toString("latin1")).toContain("(????)");
  });

  it("folds typographic punctuation that WinAnsi renders inconsistently", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("Owner’s dues — “paid”…", 40, 40);
    expect(doc.build().toString("latin1")).toContain("(Owner's dues - \"paid\"...)");
  });
});

describe("measurement, which is what right-alignment depends on", () => {
  it("measures Courier as exactly 0.6 em", () => {
    expect(textWidth("12,345.00", "mono", 10)).toBeCloseTo(9 * 6, 6);
  });

  it("knows Helvetica is proportional", () => {
    expect(textWidth("lll", "regular", 10)).toBeLessThan(textWidth("WWW", "regular", 10));
  });

  it("measures bold wider than regular for the same word", () => {
    expect(textWidth("Total", "bold", 10)).toBeGreaterThan(textWidth("Total", "regular", 10));
  });

  it("places right-aligned text so it ends at the given x", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.textRight("14,280.00", 500, 40, { font: "mono", size: 10 });
    const text = doc.build().toString("latin1");

    const placed = Number(/1 0 0 1 ([\d.]+) [\d.]+ Tm/.exec(text)?.[1]);
    expect(placed + textWidth("14,280.00", "mono", 10)).toBeCloseTo(500, 1);
  });

  it("measures an unmappable character as the '?' it will become", () => {
    expect(textWidth("ನ", "regular", 10)).toBe(textWidth("?", "regular", 10));
  });
});

describe("layout", () => {
  it("converts top-down y into PDF's bottom-up coordinates", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.text("Top", 40, 50);
    const text = doc.build().toString("latin1");
    const y = Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(text)?.[1]);
    expect(y).toBeCloseTo(PAGE_HEIGHT - 50, 1);
  });

  it("wraps to the width given and reports where it ended", () => {
    const doc = new Pdf({ createdAt: FIXED });
    const description =
      "Maintenance charge for the period April to June including sinking fund contribution";
    const end = doc.wrap(description, 40, 100, 200, { size: 9 });

    // Three lines at 9pt x 1.35 leading.
    expect(end).toBeGreaterThan(100);
    const drawn = (doc.build().toString("latin1").match(/Tj/g) ?? []).length;
    expect(drawn).toBeGreaterThan(1);
  });

  it("hard-cuts a token too long to fit rather than running off the page", () => {
    const doc = new Pdf({ createdAt: FIXED });
    doc.wrap("A".repeat(200), 40, 100, 100, { size: 9 });
    const lines = (doc.build().toString("latin1").match(/Tj/g) ?? []).length;
    expect(lines).toBeGreaterThan(1);
  });

  it("uses A4", () => {
    const text = new Pdf({ createdAt: FIXED }).build().toString("latin1");
    expect(text).toContain(`/MediaBox [0 0 ${PAGE_WIDTH.toFixed(2)} ${PAGE_HEIGHT.toFixed(2)}]`);
  });
});

describe("metadata", () => {
  it("carries a title a filing system can read", () => {
    const bytes = new Pdf({ createdAt: FIXED, title: "Invoice INV-2026-0001" }).build();
    expect(bytes.toString("latin1")).toContain("/Title (Invoice INV-2026-0001)");
  });

  it("stamps the creation date in IST", () => {
    // 06:30 UTC is noon in Kolkata.
    const bytes = new Pdf({ createdAt: FIXED }).build();
    expect(bytes.toString("latin1")).toContain("/CreationDate (D:20260401120000+05'30')");
  });

  it("produces identical bytes for identical input", () => {
    const make = (): Buffer => {
      const doc = new Pdf({ createdAt: FIXED, title: "Same" });
      doc.text("Same", 40, 40);
      return doc.build();
    };
    expect(make().equals(make())).toBe(true);
  });
});
