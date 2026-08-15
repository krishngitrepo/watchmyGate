"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The hero carousel.
 *
 * Four slides showing the product where it actually lives: a pre-authorised pass at the
 * concierge desk, the two gate cameras, and the plate-recognition decision a guard makes.
 *
 * Three decisions worth knowing about.
 *
 * **The camera chrome is drawn, not photographed.** The source frames carried burned-in
 * CCTV overlay text — the thinnest, most aliased part of the image and the first thing to
 * fall apart when enlarged. It is cropped away and redrawn here as live text, which stays
 * crisp at any pixel density and can carry a real clock.
 *
 * **Slide four is markup, not a bitmap.** It is a UI panel, so rasterising it would throw
 * away resolution for nothing. Built in DOM it is sharp on every display and readable by
 * a screen reader.
 *
 * **Autoplay stops when it should.** It pauses on hover and on keyboard focus, and never
 * starts at all under `prefers-reduced-motion`. A carousel that keeps moving while
 * someone is reading a slide is a nuisance, and one that moves under a user who asked the
 * OS for stillness is an accessibility failure.
 */

interface Slide {
  id: string;
  kind: "photo" | "panel";
  label: string;
  /** Basename in /hero — `.webp` is 1x, `@2x.webp` is 2x. */
  image?: string;
  cam?: string;
  meta?: string;
  caption: string;
  sub: string;
}

const SLIDES: Slide[] = [
  {
    id: "visitor",
    kind: "photo",
    label: "Visitor pre-authorisation at the desk",
    image: "visitor-desk",
    cam: "Lobby · Desk",
    meta: "Pass verified",
    caption: "Pre-authorised arrival",
    sub: "Pass checked on the handset — no network needed",
  },
  {
    id: "entry",
    kind: "photo",
    label: "Main entrance camera",
    image: "gate-entry",
    cam: "LPR Cam 1",
    meta: "REC",
    caption: "Main entry",
    sub: "Every entry logged with time, photo and purpose",
  },
  {
    id: "exit",
    kind: "photo",
    label: "Exit camera",
    image: "gate-exit",
    cam: "Exit Cam 2",
    meta: "REC",
    caption: "Residents-only exit",
    sub: "Matched against the entry so overstays surface on their own",
  },
  {
    id: "plate",
    kind: "panel",
    label: "Number plate recognised at the barrier",
    caption: "Approaching vehicle",
    sub: "Recognised, matched to a flat, decision left to a person",
  },
];

const INTERVAL_MS = 5000;

export function HeroCarousel() {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const touchX = useRef<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (paused || reduced) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), INTERVAL_MS);
    return () => clearInterval(t);
  }, [paused, reduced]);

  const go = useCallback((delta: number) => {
    setIndex((i) => (i + delta + SLIDES.length) % SLIDES.length);
  }, []);

  return (
    <div className="lp-hero-art">
      <div className="lp-hero-glow" />

      <div
        className="lp-carousel"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
        onTouchStart={(e) => {
          touchX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          if (start !== null && end !== undefined && Math.abs(end - start) > 40) {
            go(end < start ? 1 : -1);
          }
          touchX.current = null;
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") go(1);
          if (e.key === "ArrowLeft") go(-1);
        }}
        role="group"
        aria-roledescription="carousel"
        aria-label="WatchMyGate at the gate"
        tabIndex={0}
      >
        <div className="lp-carousel-stage">
          {SLIDES.map((s, i) => (
            <div
              key={s.id}
              className="lp-slide"
              data-active={i === index ? "true" : "false"}
              aria-hidden={i === index ? undefined : true}
            >
              {s.kind === "photo" ? (
                <>
                  <img
                    src={`/hero/${s.image}.webp`}
                    srcSet={`/hero/${s.image}.webp 1x, /hero/${s.image}@2x.webp 2x`}
                    alt={s.label}
                    width={1024}
                    height={576}
                    // The first slide is the largest thing above the fold, so it is
                    // fetched eagerly; the rest can wait until they are needed.
                    loading={i === 0 ? "eager" : "lazy"}
                    decoding="async"
                    draggable={false}
                  />
                  <div className="lp-slide-sheen" />
                  <div className="lp-cam-chip">
                    <span className="lp-cam-icon" aria-hidden="true">
                      ▣
                    </span>
                    {s.cam}
                  </div>
                  <div className="lp-cam-meta">
                    {s.meta === "REC" ? <span className="lp-rec-dot" /> : null}
                    {s.meta}
                  </div>
                </>
              ) : (
                <PlatePanel />
              )}
            </div>
          ))}
        </div>

        {/* Caption sits on frosted glass over the image, so it stays legible on any frame. */}
        <div className="lp-carousel-bar">
          <div className="lp-carousel-caption">
            <b>{SLIDES[index]!.caption}</b>
            <span>{SLIDES[index]!.sub}</span>
          </div>
          <div className="lp-carousel-dots">
            {SLIDES.map((s, i) => (
              <button
                key={s.id}
                type="button"
                className="lp-dot"
                data-active={i === index ? "true" : "false"}
                aria-label={`Show slide ${i + 1}: ${s.caption}`}
                aria-current={i === index ? "true" : undefined}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="lp-hero-badge">
        <div className="lp-hero-badge-icon" aria-hidden="true">
          ✅
        </div>
        <div>
          <b>Visitor approved</b>
          <span>Gate A · 2 seconds ago</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Slide four, in markup.
 *
 * The plate is set in a monospace face with wide tracking because that is how a plate
 * reads on a real ANPR console, and because a proportional font makes character-level
 * misreads hard to spot — which is the one thing a guard is checking for.
 *
 * Note what the buttons say. The system recognises and matches; a person still decides.
 * Software never opens a barrier on its own here.
 */
function PlatePanel() {
  return (
    <div className="lp-plate">
      <div className="lp-plate-head">
        <h3>Approaching vehicle</h3>
        <span className="lp-plate-scan">Scanning…</span>
      </div>

      <div className="lp-plate-body">
        <div className="lp-plate-number">
          <span>KA 05 MJ</span>
          <span>9876</span>
        </div>
        <div className="lp-plate-status">
          <span className="lp-plate-label">Status</span>
          <strong>Resident</strong>
          <span className="lp-plate-unit">Unit 402 · J. Menon</span>
        </div>
      </div>

      <div className="lp-plate-actions">
        <span className="lp-plate-btn" data-variant="grant">
          Grant access
        </span>
        <span className="lp-plate-btn" data-variant="deny">
          Deny
        </span>
      </div>
    </div>
  );
}
