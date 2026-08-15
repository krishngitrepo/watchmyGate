import Link from "next/link";

import { HeroCarousel } from "../components/HeroCarousel";

import "./landing.css";

/**
 * The landing page.
 *
 * Implements design/landing/source.dc.html — same structure, palette, type and rhythm.
 * The source is a design-tool export using a proprietary template syntax that only that
 * tool can render, so it is kept in the repo as the reference and this is the build.
 *
 * Two departures, both documented in design/landing/README.md:
 *
 * 1. **Fonts are self-hosted** (see layout.tsx). Tauri's CSP blocks the Google Fonts CDN
 *    the design links to, so the desktop build would silently lose the typography.
 *
 * 2. **Invented social proof is gone.** The source ships "Trusted by 5,200+ communities",
 *    three usage statistics, six named customer logos and a signed testimonial from the
 *    secretary of a society that does not exist. None of it is true — nothing is live
 *    yet — and publishing it would breach the CCPA's 2022 misleading-advertising rules,
 *    which prohibit fabricated testimonials and unsubstantiated objective claims outright.
 *    Each slot now carries something checkable in this repo instead. The markup is
 *    unchanged, so real numbers drop straight back in when they exist.
 *
 * Static by design: no "use client", no data fetching. It renders from the CDN instantly
 * and ships 0 kB of page JavaScript.
 */

/** Every module in the product, with an honest build state. */
const FEATURES: {
  icon: string;
  title: string;
  desc: string;
  status: "live" | "building";
}[] = [
  {
    icon: "🪪",
    title: "Visitor management",
    desc: "Pre-approve guests, scan QR passes and log every entry with photo and purpose.",
    status: "live",
  },
  {
    icon: "🚧",
    title: "Gate & entry approval",
    desc: "Residents approve or deny arrivals in one tap — no more phone calls to the guard.",
    status: "live",
  },
  {
    icon: "👥",
    title: "Employee & staff mgmt",
    desc: "Onboard maids, drivers and vendors with verified profiles and daily check-in.",
    status: "building",
  },
  {
    icon: "📦",
    title: "Delivery & courier tracking",
    desc: "Track packages from gate to doorstep and collect proof of handover.",
    status: "building",
  },
  {
    icon: "🛡️",
    title: "Security guard tools",
    desc: "A purpose-built guard app for patrols, incident logs and shift handover.",
    status: "building",
  },
  {
    icon: "🚨",
    title: "Emergency SOS & alerts",
    desc: "One-tap panic alerts broadcast location to guards and management instantly.",
    status: "building",
  },
  {
    icon: "🏸",
    title: "Amenity booking",
    desc: "Reserve the clubhouse, courts and halls with automatic conflict handling.",
    status: "building",
  },
  {
    icon: "📣",
    title: "Community notices",
    desc: "Publish circulars, polls and events residents actually read.",
    status: "building",
  },
  {
    icon: "🧾",
    title: "Maintenance & billing",
    desc: "Raise dues, collect payments online and reconcile in a click.",
    status: "live",
  },
  {
    icon: "🚗",
    title: "Vehicle & parking mgmt",
    desc: "Register vehicles, allot slots and flag unauthorised parking automatically.",
    status: "building",
  },
  {
    icon: "🕒",
    title: "Attendance & payroll",
    desc: "Reliable attendance for staff, with payroll-ready timesheets.",
    status: "building",
  },
  {
    icon: "📊",
    title: "Analytics & reports",
    desc: "Live dashboards on footfall, incidents, collections and staff performance.",
    status: "building",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Guest arrives",
    desc: "The guard captures the visitor at the gate — or the guest scans a pass the resident already shared.",
  },
  {
    n: "2",
    title: "Resident is pinged",
    desc: "An instant push notification asks the resident to approve or deny in one tap.",
  },
  {
    n: "3",
    title: "Gate opens",
    desc: "On approval a timed, tracked pass is issued and the barrier lifts.",
  },
  {
    n: "4",
    title: "Logged & audited",
    desc: "Every entry and exit is recorded with time, photo and purpose for later review.",
  },
];

const ROLES: { icon: string; title: string; desc: string; cta: string; bg: "card" | "sand" }[] = [
  {
    icon: "🏠",
    title: "Residents & homeowners",
    desc: "Approve guests, book amenities, pay dues and raise SOS — from one friendly app.",
    cta: "Explore the resident app",
    bg: "card",
  },
  {
    icon: "🧑‍💼",
    title: "Community managers & RWA",
    desc: "Run the whole society: staff, billing, notices, complaints and reports in one console.",
    cta: "See the admin dashboard",
    bg: "sand",
  },
  {
    icon: "💂",
    title: "Security agencies",
    desc: "A simple, fast app for approvals, patrols, deliveries and incident reporting.",
    cta: "See the guard app",
    bg: "sand",
  },
  {
    icon: "🏗️",
    title: "Developers & builders",
    desc: "Standardise security and reporting across every project and site you operate.",
    cta: "Talk to us",
    bg: "card",
  },
];

/**
 * Pricing.
 *
 * The design prices these at ₹29 and ₹49 per home per month. The approved plan sets
 * ₹8–15, chosen against a market where MyGate sits at ₹3–15 — so ₹29–49 is 2–4× every
 * incumbent, which is a positioning decision rather than a design detail. The plan's
 * numbers are used here; changing them is this array and nothing else.
 */
const PLANS = [
  {
    name: "Starter",
    price: "₹8",
    per: "/ home / month",
    tag: "For small societies getting organised.",
    feats: [
      "Visitor & gate approvals",
      "Guard app for one gate",
      "Community notices",
      "Email support",
    ],
    btn: "Start a free pilot",
    popular: false,
  },
  {
    name: "Community",
    price: "₹12",
    per: "/ home / month",
    tag: "The complete platform for growing communities.",
    feats: [
      "Everything in Starter",
      "Unlimited gates & staff management",
      "Billing, payroll & amenities",
      "SOS & analytics",
      "Priority support",
    ],
    btn: "Book a demo",
    popular: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    per: "",
    tag: "For developers and security agencies at scale.",
    feats: [
      "Multi-site management",
      "Custom integrations & API",
      "Dedicated success manager",
      "SLA & onboarding",
    ],
    btn: "Contact sales",
    popular: false,
  },
];

/**
 * Replaces the design's customer-logo strip.
 *
 * There are no customers to name yet. Naming the regimes the product is actually
 * engineered against is the same reassurance to a committee and is verifiable —
 * design/SECURITY_COMPLIANCE.md carries the detail behind each.
 */
const STANDARDS = [
  "DPDP Act 2023",
  "TRAI DLT",
  "RBI · no funds held",
  "GST rule engine",
  "Karnataka KAOA",
  "Maharashtra MCS",
];

const REFUSALS = [
  {
    title: "Remotely disabling a vehicle",
    body: "A car that stops moving on a command from an app can kill someone. We alert the owner instead.",
  },
  {
    title: "Selling resident data",
    body: "Not to advertisers, not to brokers, not to anyone. It is the entire business model of some products in this category.",
  },
  {
    title: "Profiling domestic staff",
    body: "“AI anomaly detection” aimed at the lowest-paid people at your gate is surveillance with a nicer name. Software never denies a person entry here.",
  },
  {
    title: "Storing Aadhaar numbers",
    body: "Verification through DigiLocker, and we keep the result — never the number.",
  },
];

const FOOTER_COLS = [
  {
    title: "Product",
    links: ["Visitor management", "Guard app", "Admin dashboard", "Resident app", "Pricing"],
  },
  { title: "Solutions", links: ["Apartments", "Gated estates", "Developers", "Security agencies"] },
  { title: "Company", links: ["About", "Careers", "Contact", "Security & privacy"] },
];

function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M20 2.5 L35 8 V20 C35 30 28.5 36 20 38.5 C11.5 36 5 30 5 20 V8 Z"
        fill="#6E2436"
        stroke="#C8862A"
        strokeWidth="1.4"
      />
      <rect x="13" y="15.5" width="14" height="12" rx="1.2" fill="#E9C77E" />
      <path
        d="M15.5 15.5 V12.5 A4.5 4.5 0 0 1 24.5 12.5 V15.5"
        stroke="#C8862A"
        strokeWidth="2"
        fill="none"
      />
      <circle cx="20" cy="20.5" r="2" fill="#6E2436" />
      <rect x="19.1" y="21" width="1.8" height="4" rx="0.9" fill="#6E2436" />
    </svg>
  );
}

export default function Landing() {
  return (
    <div className="lp">
      <header className="lp-nav">
        <div className="lp-wrap lp-nav-inner">
          <Link href="/" className="lp-brand">
            <Logo />
            <span className="lp-brand-name">
              Watch<em>My</em>Gate
            </span>
          </Link>
          <nav className="lp-nav-links">
            <a href="#features">Product</a>
            <a href="#roles">Solutions</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="lp-nav-cta">
            <Link href="/login/" className="lp-link-plain">
              Log in
            </Link>
            <a href="#demo" className="lp-btn lp-btn-primary">
              Book a demo
            </a>
          </div>
        </div>
      </header>

      <main>
        {/* ---------------------------------------------------------- hero */}
        <section className="lp-wrap lp-hero" id="top">
          <div>
            <span className="lp-pill">
              <span className="lp-pill-dot" />
              Built for Indian housing societies
            </span>
            <h1>
              Security your community <em>actually feels.</em>
            </h1>
            <p className="lp-hero-lede">
              One platform for gate access, visitor approvals, staff attendance and
              community operations — so residents feel safe and managers stay in control.
            </p>
            <div className="lp-hero-actions">
              <a href="#demo" className="lp-btn lp-btn-primary lp-btn-lg">
                Book a demo
              </a>
              <a href="#how" className="lp-btn lp-btn-ghost lp-btn-lg">
                See how it works
              </a>
            </div>

            {/*
              The design shows adoption numbers here. Nothing is live, so these are the
              three architectural guarantees instead — each true today and checkable in
              the codebase.
            */}
            <div className="lp-proof">
              <div className="lp-proof-item">
                <strong>Works with no signal</strong>
                <span>Passes verify on the guard&apos;s phone, offline</span>
              </div>
              <div className="lp-proof-rule" />
              <div className="lp-proof-item">
                <strong>Money never touches us</strong>
                <span>Dues settle straight to the society&apos;s bank</span>
              </div>
              <div className="lp-proof-rule" />
              <div className="lp-proof-item">
                <strong>Books cannot be edited</strong>
                <span>The database itself refuses, not just the app</span>
              </div>
            </div>
          </div>

          <HeroCarousel />
        </section>

        {/* --------------------------------------------------------- trust */}
        <section className="lp-trust">
          <div className="lp-wrap lp-trust-inner">
            <span className="lp-trust-label">Engineered against</span>
            {STANDARDS.map((s) => (
              <span key={s} className="lp-trust-item">
                {s}
              </span>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------ features */}
        <section className="lp-wrap lp-section" id="features">
          <div className="lp-section-head">
            <span className="lp-eyebrow">One platform</span>
            <h2>Everything your gate does, done better.</h2>
            <p>
              Twelve tightly-integrated modules replace the registers, WhatsApp groups and
              spreadsheets your community runs on today.
            </p>
          </div>
          <div className="lp-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="lp-feature">
                <div className="lp-feature-icon" aria-hidden="true">
                  {f.icon}
                </div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
                <span className="lp-status" data-s={f.status}>
                  {f.status === "live" ? "Available" : "In build"}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------- how */}
        <section className="lp-band" id="how">
          <div className="lp-wrap lp-band-inner">
            <div className="lp-section-head lp-center">
              <span className="lp-eyebrow">A visitor arrives</span>
              <h2>Four steps from gate to doorstep.</h2>
            </div>
            <div className="lp-steps">
              {STEPS.map((s) => (
                <div key={s.n} className="lp-step">
                  <div className="lp-step-n">{s.n}</div>
                  <h3>{s.title}</h3>
                  <p>{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------- roles */}
        <section className="lp-wrap lp-section" id="roles">
          <div className="lp-section-head">
            <span className="lp-eyebrow">Built for everyone at the gate</span>
            <h2>One system, four points of view.</h2>
          </div>
          <div className="lp-roles">
            {ROLES.map((r) => (
              <div key={r.title} className="lp-role" data-bg={r.bg}>
                <div className="lp-role-icon" aria-hidden="true">
                  {r.icon}
                </div>
                <div>
                  <h3>{r.title}</h3>
                  <p>{r.desc}</p>
                  <a href="#demo">{r.cta} →</a>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------- SOS */}
        <section className="lp-wrap lp-sos">
          <div className="lp-sos-inner">
            <div className="lp-sos-glow" />
            <div className="lp-sos-copy">
              <span className="lp-pill lp-pill-dark">Emergency response</span>
              <h2>One tap connects residents, guards and management.</h2>
              <p>
                SOS alerts broadcast the resident&apos;s location to the gate and every
                nearby responder in real time, with a full audit trail.
              </p>
            </div>
            <div className="lp-sos-cards">
              <div className="lp-sos-card">
                <span aria-hidden="true" style={{ fontSize: 22 }}>
                  🚨
                </span>
                <div>
                  <b>SOS from Flat B-704</b>
                  <span>Broadcast to 3 guards · 0:04</span>
                </div>
              </div>
              <div className="lp-sos-card">
                <span aria-hidden="true" style={{ fontSize: 22 }}>
                  📍
                </span>
                <div>
                  <b>Guard en route</b>
                  <span>Tower B lobby · acknowledged</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------- refusals */}
        <section className="lp-wrap lp-refusals">
          <div className="lp-refusals-head">
            <span className="lp-eyebrow">Where we draw the line</span>
            <h2>Things we will not build.</h2>
            <p>
              You have been pitched some of these. We think they are wrong, and would
              rather lose the deal than sell them.
            </p>
          </div>
          <ul className="lp-refusal-list">
            {REFUSALS.map((r) => (
              <li key={r.title} className="lp-refusal">
                <b>{r.title}</b>
                {r.body}
              </li>
            ))}
          </ul>
        </section>

        {/* ------------------------------------------------------ pricing */}
        <section className="lp-wrap lp-pricing" id="pricing">
          <div className="lp-section-head lp-center">
            <span className="lp-eyebrow">Pricing</span>
            <h2>Priced per home. Scales with you.</h2>
          </div>
          <div className="lp-plans">
            {PLANS.map((p) => (
              <div key={p.name} className="lp-plan" data-popular={String(p.popular)}>
                {p.popular ? <span className="lp-plan-flag">MOST POPULAR</span> : null}
                <h3>{p.name}</h3>
                <div className="lp-plan-priceline">
                  <span className="lp-plan-price">{p.price}</span>
                  {p.per ? <span className="lp-plan-per">{p.per}</span> : null}
                </div>
                <p className="lp-plan-tag">{p.tag}</p>
                <div className="lp-plan-feats">
                  {p.feats.map((ft) => (
                    <div key={ft} className="lp-plan-feat">
                      <span className="lp-plan-check">✓</span>
                      <span>{ft}</span>
                    </div>
                  ))}
                </div>
                <a
                  href="#demo"
                  className={`lp-btn ${p.popular ? "lp-btn-gold" : "lp-btn-ghost"}`}
                >
                  {p.btn}
                </a>
              </div>
            ))}
          </div>
          <p className="lp-pricing-note">
            Billed to the society, not to residents. No advertising, and your residents&apos;
            data is never sold — that is a contractual commitment, not a setting.
          </p>
        </section>

        {/* ---------------------------------------------------------- CTA */}
        <section className="lp-wrap lp-cta" id="demo">
          <div className="lp-cta-inner">
            <div className="lp-cta-glow" />
            <div className="lp-cta-content">
              <h2>See WatchMyGate at your gate.</h2>
              <p>
                Book a 20-minute walkthrough. We&apos;ll map it to your community and set
                up a free pilot at one gate.
              </p>
              <div className="lp-cta-actions">
                <a href="mailto:hello@watchmygate.in" className="lp-btn lp-btn-gold lp-btn-lg">
                  Book a demo
                </a>
                <a
                  href="mailto:hello@watchmygate.in"
                  className="lp-btn lp-btn-outline-light lp-btn-lg"
                >
                  Talk to sales
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-wrap">
        <div className="lp-footer">
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Logo size={28} />
              <span className="lp-brand-name" style={{ fontSize: 18 }}>
                WatchMyGate
              </span>
            </div>
            <p>
              Security your community actually feels. Access, visitors, staff and
              operations in one trusted platform.
            </p>
          </div>
          {FOOTER_COLS.map((col) => (
            <div key={col.title}>
              <div className="lp-footer-col-title">{col.title}</div>
              <div className="lp-footer-links">
                {col.links.map((l) => (
                  <a key={l} href="#features">
                    {l}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="lp-colophon">
          <span>© 2026 WatchMyGate Technologies. All rights reserved.</span>
          <span>Privacy · Terms · Security</span>
        </div>
      </footer>
    </div>
  );
}
