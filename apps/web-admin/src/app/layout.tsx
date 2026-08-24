import type { Metadata } from "next";
import { Bricolage_Grotesque, Manrope } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

/**
 * Fonts, self-hosted.
 *
 * The design links these from the Google Fonts CDN. That cannot ship: this console is
 * packaged into the desktop build, whose CSP blocks external hosts, so the link would
 * fail silently and the page would drop to a system sans — losing the entire typographic
 * identity on precisely the build handed to a society.
 *
 * `next/font/google` fetches both families at build time and serves them from our own
 * origin. Same typefaces, no runtime dependency on anyone else, and no layout shift.
 */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--lp-font-display",
  display: "swap",
});

const body = Manrope({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--lp-font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "WatchMyGate — Security your community actually feels",
  description:
    "Gate access, visitor approvals, staff attendance and community operations for Indian housing societies — in one platform.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
