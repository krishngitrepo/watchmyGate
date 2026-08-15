# Landing page design

`source.dc.html` is the original export from the design tool, kept verbatim as the
reference. It is **not** built or served — it uses a proprietary template syntax
(`<x-dc>`, `<sc-if>`, `<sc-for>`, a `DCLogic` class) that only that tool understands, and
it pulls fonts from a CDN. The live implementation is
[`apps/web-admin/src/app/page.tsx`](../../apps/web-admin/src/app/page.tsx) with
[`landing.css`](../../apps/web-admin/src/app/landing.css).

## Design tokens, as implemented

| Token | Value | Role |
|---|---|---|
| `--lp-paper` | `#FAF5EE` | page background |
| `--lp-paper-2` | `#F6EDDF` | alternating band |
| `--lp-card` | `#FFFDF9` | card surface |
| `--lp-ink` | `#3A2E24` | headings |
| `--lp-ink-2` | `#6B5C4C` | body copy |
| `--lp-ink-3` | `#8A7B6B` | captions |
| `--lp-maroon` | `#6E2436` | primary brand / buttons |
| `--lp-maroon-deep` | `#5A1C2C` | dark bands |
| `--lp-gold` | `#C8862A` | eyebrows, accents |
| `--lp-gold-soft` | `#E9C77E` | on dark backgrounds |
| `--lp-gold-btn` | `#D99A2B` | buttons on dark |
| `--lp-line` | `#EADFCF` | borders |

Type: **Bricolage Grotesque** for display, **Manrope** for body — as designed.

## Two deliberate departures from the source

### 1. Fonts are self-hosted, not CDN-linked

The source has `<link href="https://fonts.googleapis.com/...">`. The console is packaged
by Tauri for the desktop build, and Tauri's CSP blocks external hosts outright — that link
would silently fail and the page would fall back to a system sans, losing the entire
typographic identity on exactly the build we hand to a society.

`next/font/google` downloads both families at build time and serves them from our own
origin, so the design survives in the desktop shell. Same fonts, no runtime dependency on
Google.

### 2. Fabricated social proof was removed

The source carries placeholder marketing numbers that are presented as fact:

- "Trusted by 5,200+ communities"
- "2.4M visitors verified / day", "99.9% gate uptime", "18 sec avg. entry approval"
- Six named customer logos (Palm Grove, Skyline Estates, Marina Heights, …)
- A signed testimonial from "Meera Nair, Secretary, Palm Grove Residency (480 homes)"

None of it is true. There are no live societies, so every one of these is an invented
customer or an unmeasured statistic.

Beyond being false, publishing them is illegal in India. The Consumer Protection Act 2019
and the CCPA's *Guidelines for Prevention of Misleading Advertisements and Endorsements*
(2022) require every objective claim to be substantiated and prohibit fabricated
testimonials, with penalties up to ₹10 lakh and ₹50 lakh on repeat. A fake named secretary
of a fake society is the clearest possible case.

They are replaced with claims that are true today and checkable in this repo — the
architectural guarantees rather than adoption numbers. The layout, rhythm and visual
weight of each slot is preserved, so the page still reads as designed:

| Source slot | Replaced with | Verifiable at |
|---|---|---|
| "5,200+ communities" | "Built for Indian housing societies" | — |
| 3 usage stats | Offline gate verification · direct-to-society settlement · immutable ledger | `gate/passes.ts`, `payments/`, `0003_phase1_policies.sql` |
| 6 customer logos | The compliance regimes actually engineered for | `design/SECURITY_COMPLIANCE.md` |
| Customer testimonial | "What we will not build" commitments | `design/ARCHITECTURE.md` §1 |

Restore any of it the moment it becomes true — the markup slots are unchanged.

## Hero carousel

Four slides in the hero's right column, replacing the design's single photo slot.
Component: [`HeroCarousel.tsx`](../../apps/web-admin/src/components/HeroCarousel.tsx).

| # | Slide | Source |
|---|---|---|
| 1 | Visitor pre-authorisation at the desk | photo, `visitor-desk.webp` |
| 2 | Main entrance camera | photo, `gate-entry.webp` |
| 3 | Residents-only exit camera | photo, `gate-exit.webp` |
| 4 | Number plate recognised | **drawn in CSS**, no bitmap |

### Where the photos came from, and their ceiling

The screenshots supplied were downscaled copies. The originals were traced through the
Stitch exports in `~/Downloads/watchmygatedesign/*/code.html` and fetched from their
`lh3.googleusercontent.com` sources — **512×279 is Stitch's native output**, and therefore
the hard ceiling on real detail. No amount of processing adds any.

`prep_hero.py` (archived beside this file) does what can honestly be done:

1. **Crops the burned-in CCTV overlay text.** Thin, aliased, already marginal at native
   size, and the first thing to disintegrate when enlarged. It is redrawn as live text in
   CSS, which stays crisp at any pixel density and can carry a real clock.
2. **Lanczos resample to 2×, then a restrained unsharp mask** (radius 1.6, 105%,
   threshold 3). Threshold is non-zero so flat sky and tarmac do not gain noise. This
   reads noticeably sharper than leaving a 512px file to be stretched by the browser.
3. **Ships 1× and 2× via `srcset`**, so ordinary displays get the pristine native size and
   retina displays get the resampled one. Neither is penalised for the other.
4. **WebP at q92** — smaller and cleaner than JPEG at matched quality. Total 605 KB across
   six files.

Slide 4 is markup rather than a cropped bitmap for the same reason: it is UI, so
rasterising it would discard resolution for nothing.

### Competitor branding removed

The concierge photo carried **FortressGate** — a different product's name — twice: in
large letters on the back wall, and again in the tablet's own header. Both are blurred
with a feathered mask, so they read as depth of field and screen glare rather than as
redaction.

The gate photos show "The Oaks Estates" and "Oakhaven Estates" on the signage. Those read
as ordinary stock-photo communities rather than a competing product, so they are left
alone.

**These remain stock images of North American communities.** They are fine for now, but
photographs of an actual Indian society — ideally the pilot — will outperform them
considerably with the audience that matters, and at a resolution that is not capped at
512 px.

## Pricing

The source prices Starter at ₹29/home/month and Community at ₹49. The approved plan sets
**₹8–15/flat/month**, chosen against MyGate's market range of ₹3–15; ₹29–49 is 2–4× above
every incumbent. The implementation uses the plan's numbers. If the higher pricing is
intended, it is the `plans` array in `page.tsx` and nothing else.
