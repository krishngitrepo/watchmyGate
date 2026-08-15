Not built at all

The two Flutter apps. Neither apps/mobile-guard nor apps/mobile-resident exists. This is the largest gap by far, and the guard app is the product's actual differentiator — the offline SQLite outbox, Ed25519 verification against a cached key with no network, the Dart runner that proves both languages compute identical money from the golden vectors. Every server-side half of that is built and tested. The handset half is untouched.

Without it there is no product at a gate, and no way to demo the one thing no competitor does cleanly.

apps/ai-service is a skeleton — config, error handling, an HTTP client, and empty modules/. No Claude OCR for bank statements, no voice complaint filing in 8 languages, no gate device drivers. This is the Python side of the split you specified, and it's the only part of that split not yet real.

Built but unproven
Everything payment-related past the code. The webhook signature check, Route settlement, direct-merchant Mode 2 — all written, none exercised against Razorpay test mode. The e2e proves an unsigned webhook is rejected; it doesn't prove a signed one settles correctly, because that needs your keys.

The desktop app has never been compiled. The Tauri config is right and now points at a real out/ directory, but npm run desktop:build has not been run — it needs the Rust toolchain, and I haven't verified it installs here.

Deferred by the plan, not forgotten
Notices and multi-channel comms, amenity booking UI, document repository, Tally export, the report pack, DPDP consent manager, and the migration tooling for importing from competitors. That last one matters commercially more than it sounds — it's what decides whether a 400-flat society can actually switch.

Blocked on you
Razorpay with Route and Smart Collect enabled, MSG91 with DLT-registered templates, Cloudflare R2, FCM, a GCP project, Exotel, and an Anthropic key. All stubbed, so none of them block further building — only going live.

What I'd do next
The guard app. It's the highest-risk piece remaining, it's what makes the product distinctive, and everything it depends on server-side is already proven. The resident app is more feature surface but far less risk.



audience: Residents / homeowners, Community managers / RWA admins, Security agencies, Property developers / builders

Visitor management — Pre-approve guests, scan QR passes, log every entry with photo and purpose.
Gate & entry approval — Residents approve/deny arrivals in one tap.
Employee & staff mgmt — Onboard maids, drivers, vendors with verified profiles and daily check-in.
Delivery & courier tracking — Track packages gate-to-doorstep with proof of handover.
Security guard tools — Guard app for patrols, incident logs, shift handover.
Emergency SOS & alerts — One-tap panic alerts broadcast location to guards and management.
Amenity booking — Reserve clubhouse, courts, halls with conflict handling.
Community notices — Circulars, polls and events residents actually read.
Maintenance & billing — Raise dues, collect payments online, reconcile in a click.
Vehicle & parking mgmt — Register vehicles, allot slots, flag unauthorised parking.
Attendance & payroll — Biometric-grade staff attendance with payroll-ready timesheets.
Analytics & reports — Live dashboards on footfall, incidents, collections, staff performance.