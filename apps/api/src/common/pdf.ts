/**
 * A minimal PDF writer.
 *
 * ## Why this is hand-written rather than a library
 *
 * An invoice and a receipt are text on a page: no images, no charts, no embedded fonts.
 * That is a few hundred lines of PDF 1.4, and writing it directly buys three things a
 * library would have cost us.
 *
 * **Size.** Base-14 fonts are guaranteed present in every PDF viewer, so nothing is
 * embedded. An invoice comes out around 4 KB. The same page from a library that subsets
 * a TrueType face is 40-80 KB. A thousand societies issuing 250 invoices a month is
 * 250,000 documents; at R2 pricing the difference is real money for zero benefit.
 *
 * **Determinism.** The bytes are a pure function of the content and the creation date,
 * so a test can assert on them. That is how the invoice tests catch a layout change that
 * silently drops the GST line.
 *
 * **No dependency.** Nothing to audit, nothing to patch, no native build step on
 * Cloud Run.
 *
 * ## The rupee sign, which is the one real trap here
 *
 * U+20B9 is not in WinAnsiEncoding and the base-14 Helvetica has no glyph for it.
 * Emitting it produces a blank box or a dropped character depending on the viewer - and
 * it is exactly the character an invoice cannot afford to lose. So `encode()` rewrites it
 * to `Rs.`, which is what printed Indian invoices have always used and what a viewer will
 * always render. Embedding a font with a rupee glyph to avoid this would cost 60 KB per
 * document to gain nothing an accountant would notice.
 *
 * ## Coordinates
 *
 * PDF's origin is the bottom-left corner and y grows upward, which makes laying out a
 * document top-to-bottom an exercise in subtraction. Every public method here takes y
 * measured **down from the top of the page**, and converts once on the way out.
 */

/** A4, in points. 1 pt = 1/72 inch. */
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;

export type PdfFont = "regular" | "bold" | "mono";

const FONT_RESOURCE: Record<PdfFont, string> = {
  regular: "F1",
  bold: "F2",
  mono: "F3",
};

/**
 * Adobe Core 14 character widths, in 1/1000 em, for codes 32-126.
 *
 * Needed because right-aligning a column of amounts requires knowing how wide the string
 * is before it is drawn, and Helvetica is proportional. Courier is monospaced at 600, so
 * it gets a constant - which is also why amounts are set in Courier: a column of figures
 * that lines up digit-for-digit is easier to check by eye, and an accountant checks by
 * eye.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD_WIDTHS = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/**
 * Down-convert to something WinAnsiEncoding and a base-14 font can actually draw.
 *
 * Anything left unmapped above U+00FF becomes `?`. That is deliberate and visible: a
 * silent drop would let a Kannada flat description vanish from an invoice without anyone
 * noticing. (Non-Latin scripts need an embedded font; when a society needs invoices in
 * Kannada this is the function that will tell us, loudly.)
 */
function encode(text: string): Buffer {
  const folded = text
    .replace(/₹/g, "Rs.")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^ -ÿ]/g, "?");

  // Escape the three characters that would end a PDF string literal early.
  const escaped = folded.replace(/([\\()])/g, "\\$1");
  return Buffer.from(escaped, "latin1");
}

export interface TextOptions {
  font?: PdfFont;
  size?: number;
  /** RGB, each 0-1. Defaults to black. */
  colour?: [number, number, number];
}

export interface PdfMeta {
  title?: string | undefined;
  subject?: string | undefined;
  /** Passed explicitly by tests so the bytes are reproducible. */
  createdAt?: Date;
}

/** Width of `text` at `size`, in points. */
export function textWidth(text: string, font: PdfFont, size: number): number {
  if (font === "mono") return text.length * 0.6 * size;
  const table = font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  const fallback = "?".charCodeAt(0) - 32;
  let thousandths = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Unmapped characters render as '?', so measure them as '?'.
    const index = code >= 32 && code <= 126 ? code - 32 : fallback;
    thousandths += table[index] ?? 500;
  }
  return (thousandths / 1000) * size;
}

export class Pdf {
  private readonly completed: string[] = [];
  private current: string[] = [];
  private readonly meta: PdfMeta;

  constructor(meta: PdfMeta = {}) {
    this.meta = meta;
  }

  /** Start a new page. The current one is closed off as-is. */
  newPage(): void {
    this.completed.push(this.current.join("\n"));
    this.current = [];
  }

  /** How many pages the document will have if built now. */
  get pageCount(): number {
    return this.completed.length + 1;
  }

  text(value: string, x: number, yFromTop: number, options: TextOptions = {}): void {
    const { font = "regular", size = 10, colour } = options;
    const y = PAGE_HEIGHT - yFromTop;
    const body = encode(value).toString("latin1");
    const paint = colour ? `${fmt(colour[0])} ${fmt(colour[1])} ${fmt(colour[2])} rg\n` : "";
    this.current.push(
      `${paint}BT /${FONT_RESOURCE[font]} ${fmt(size)} Tf 1 0 0 1 ${fmt(x)} ${fmt(y)} Tm (${body}) Tj ET` +
        (colour ? "\n0 0 0 rg" : ""),
    );
  }

  /** Right-aligned: `xRight` is where the text ends, not where it starts. */
  textRight(value: string, xRight: number, yFromTop: number, options: TextOptions = {}): void {
    const width = textWidth(value, options.font ?? "regular", options.size ?? 10);
    this.text(value, xRight - width, yFromTop, options);
  }

  textCentre(value: string, xCentre: number, yFromTop: number, options: TextOptions = {}): void {
    const width = textWidth(value, options.font ?? "regular", options.size ?? 10);
    this.text(value, xCentre - width / 2, yFromTop, options);
  }

  /**
   * Wrap `value` into `width` points, returning the y the caller should continue at.
   *
   * Long unbroken tokens are hard-cut rather than allowed to run off the page - a
   * 300-character description with no spaces is rare, but it must not overwrite the
   * amount column when it happens.
   */
  wrap(
    value: string,
    x: number,
    yFromTop: number,
    width: number,
    options: TextOptions & { lineHeight?: number } = {},
  ): number {
    const { font = "regular", size = 10 } = options;
    const lineHeight = options.lineHeight ?? size * 1.35;
    const words = value.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (textWidth(word, font, size) <= width) {
        line = word;
        continue;
      }
      // Hard-cut an over-long token.
      let chunk = "";
      for (const char of word) {
        if (chunk && textWidth(chunk + char, font, size) > width) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);

    let y = yFromTop;
    for (const each of lines) {
      this.text(each, x, y, options);
      y += lineHeight;
    }
    return y;
  }

  line(
    x1: number,
    y1FromTop: number,
    x2: number,
    y2FromTop: number,
    options: { width?: number; colour?: [number, number, number] } = {},
  ): void {
    const { width = 0.5, colour = [0.8, 0.8, 0.8] } = options;
    this.current.push(
      `${fmt(colour[0])} ${fmt(colour[1])} ${fmt(colour[2])} RG ${fmt(width)} w ` +
        `${fmt(x1)} ${fmt(PAGE_HEIGHT - y1FromTop)} m ${fmt(x2)} ${fmt(PAGE_HEIGHT - y2FromTop)} l S`,
    );
  }

  rect(
    x: number,
    yFromTop: number,
    width: number,
    height: number,
    colour: [number, number, number],
  ): void {
    this.current.push(
      `${fmt(colour[0])} ${fmt(colour[1])} ${fmt(colour[2])} rg ` +
        `${fmt(x)} ${fmt(PAGE_HEIGHT - yFromTop - height)} ${fmt(width)} ${fmt(height)} re f 0 0 0 rg`,
    );
  }

  /**
   * Assemble the file.
   *
   * The cross-reference table carries a byte offset per object, and a viewer that finds a
   * wrong one refuses the whole document. So offsets are measured off the accumulated
   * buffer rather than computed from string lengths - `encode()` can turn one character
   * into three.
   */
  build(): Buffer {
    const pages = [...this.completed, this.current.join("\n")];
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let length = 0;

    const push = (value: string | Buffer): void => {
      const buffer = typeof value === "string" ? Buffer.from(value, "latin1") : value;
      chunks.push(buffer);
      length += buffer.length;
    };

    // Object numbering: 1 catalog, 2 pages, 3 info, 4-6 fonts, then two objects per page
    // - the page itself and its content stream.
    const FIRST_PAGE_OBJECT = 7;
    const pageObjectNumber = (index: number): number => FIRST_PAGE_OBJECT + index * 2;
    const contentObjectNumber = (index: number): number => FIRST_PAGE_OBJECT + index * 2 + 1;

    const obj = (number: number, body: string | Buffer): void => {
      offsets[number] = length;
      push(`${number} 0 obj\n`);
      push(body);
      push("\nendobj\n");
    };

    push("%PDF-1.4\n");
    // A comment of high-bit bytes, which is how a file declares itself binary. Without it
    // some transfer paths "helpfully" convert line endings and corrupt the streams.
    push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const kids = pages.map((_, index) => `${pageObjectNumber(index)} 0 R`).join(" ");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    obj(3, this.infoDictionary());
    obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj(
      5,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    );
    obj(6, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");

    pages.forEach((content, index) => {
      obj(
        pageObjectNumber(index),
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(PAGE_WIDTH)} ${fmt(PAGE_HEIGHT)}] ` +
          `/Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> ` +
          `/Contents ${contentObjectNumber(index)} 0 R >>`,
      );
      const stream = Buffer.from(content, "latin1");
      obj(
        contentObjectNumber(index),
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"),
          stream,
          Buffer.from("\nendstream", "latin1"),
        ]),
      );
    });

    const objectCount = contentObjectNumber(pages.length - 1) + 1;
    const xrefOffset = length;
    push(`xref\n0 ${objectCount}\n`);
    push("0000000000 65535 f \n");
    for (let number = 1; number < objectCount; number += 1) {
      // Exactly 20 bytes per entry, or every offset after it is misread.
      push(`${String(offsets[number] ?? 0).padStart(10, "0")} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${objectCount} /Root 1 0 R /Info 3 0 R >>\n`);
    push(`startxref\n${xrefOffset}\n%%EOF\n`);

    return Buffer.concat(chunks);
  }

  private infoDictionary(): string {
    const when = this.meta.createdAt ?? new Date();
    const parts = ["/Producer (WatchMyGate)", `/CreationDate (${pdfDate(when)})`];
    if (this.meta.title) parts.push(`/Title (${encode(this.meta.title).toString("latin1")})`);
    if (this.meta.subject) parts.push(`/Subject (${encode(this.meta.subject).toString("latin1")})`);
    return `<< ${parts.join(" ")} >>`;
  }
}

/** PDF wants `D:YYYYMMDDHHmmSS+HH'mm'`. Every society here is in IST, so it is a constant. */
function pdfDate(when: Date): string {
  const ist = new Date(when.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `D:${ist.getUTCFullYear()}${pad(ist.getUTCMonth() + 1)}${pad(ist.getUTCDate())}` +
    `${pad(ist.getUTCHours())}${pad(ist.getUTCMinutes())}${pad(ist.getUTCSeconds())}+05'30'`
  );
}

/** Trim float noise: `0.30000000000000004` in a content stream is legal but wasteful. */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
