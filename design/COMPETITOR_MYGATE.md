# MyGate — feature inventory and gap analysis

Built from three sources supplied on 17 Aug 2026, all in this folder:

| Source | What it gives |
|---|---|
| `MyGate Saas Full Brochure RGB_compressed (2).pdf` (9 pp) | Positioning and headline scale claims |
| `Sales Deck - Feb' 2026 (2) (1).pdf` (120 pp) | The real feature inventory, module by module, including everything shipped in the last 18 months |
| `notes_mygate.txt` | Notes from an actual sales conversation — **the only source here for real pricing** |

Read with `PLANS.md`, which turns this into our Basic and Pro packaging.

---

## 1. What MyGate claims, and what it means for us

From the brochure and deck, February 2026:

| Claim | Figure |
|---|---|
| Communities | 25,000–27,000 |
| Homes / families | 4–5 million |
| Cities | 27 major, 50+ total |
| Annual visitor entries validated | 1.2 billion |
| Annual dues collected | ₹4,500 cr (deck p93) / $350mn (brochure) |
| Invoicing value on the platform | ₹9,000 cr |
| Invoices raised annually | 1.5 crore |
| Helpdesk tickets annually | 85 lakh |
| Amenity bookings annually | 24 lakh |
| App ratings | 4.7 (98k) and 4.5 (71k) |
| Claimed market share, 2026 | 74% (Redseer) |
| Payment adoption in-app | 71% |

**The honest reading.** A 74% share and 27,000 communities means this is not a market
won by having features MyGate lacks — they have around 250 of them and a 60k-strong admin
user base. The deck's own "what sets us apart" pages are almost entirely *accounting
workflow depth*: multi-level PR/PO approvals, slab-based penalties, audit locks by
financial year, side-by-side invoice previews. That is where they have spent the last two
years, and it tells us where they think the moat is.

Three things in these documents are worth more than the feature list:

1. **Their data retention is 6 months for entry/exit** (sales notes), after which it is
   deleted. That is a defensible DPDP posture and we should match or beat it, deliberately
   rather than by accident.
2. **They charge the resident a payment platform fee** — ₹5.9 and ₹11 appear in the notes
   against Razorpay. Every rupee of that is a resident's, on top of maintenance. Our
   architecture takes no cut of a resident payment at all, and UPI is 0% by RBI mandate.
   That is a difference a treasurer can check on their own bank statement.
3. **Pricing is per society per year, flat** — not per flat. See `PLANS.md`; this is the
   single most commercially important fact in the folder.

---

## 2. Module-by-module comparison

Status uses the same vocabulary as `BACKLOG.md`: **Done** means built *and* covered by a
test that would fail if it broke. **Partial** means some of it. **Todo** means nothing.

### 2.1 Standard module — the gate

| # | MyGate feature | WatchMyGate | Note |
|---|---|---|---|
| 1 | Visitor management (entry/exit) | **Done** | Plus something they do not have: passes verify offline against a cached Ed25519 key |
| 2 | Delivery management | **Done** | Gate → doorstep states; a handover with nobody named is refused |
| 3 | Daily help management | **Done** | `staff` module — maid, cook, nanny, driver, gardener, vendor staff |
| 4 | Vehicle management | **Done** | Plate normalised on write, so gate lookup matches regardless of spacing |
| 5 | **Kids checkout** | **Todo** | Child leaves the gate → guardian is notified and must approve. Genuinely valuable, and small |
| 6 | Resident directory | **Partial** | Roles directory exists; the neighbour-facing directory with privacy controls does not |
| 7 | Overstay alert | **Done** | Sweep job flags an entry with no matching exit |
| 8 | Attendance marking | **Done** | PIN, card, manual, gate scan; biometric is opt-in with a PIN always offered |
| 9 | Pre-approved entry | **Done** | **Our strongest differentiator.** Works with the network down |
| 10 | Emergency calling | **Partial** | SOS is done; the offline emergency contact directory is not |

Also in the deck's gate module, beyond the ten:

| MyGate feature | WatchMyGate | Note |
|---|---|---|
| Guard patrolling with real-time status | **Todo** | Named in the Elite list too. Geofenced check-ins |
| Digital register (replacing the paper book) | **Todo** | Sales notes flag it specifically for trucks. Single-click Excel export is the whole pitch |
| Frequent visitor list / one-click invites | **Partial** | Passes exist; "invite my regulars again" does not |
| Guest / visitor parking management | **Partial** | Slot kinds include `visitor`; no guest allotment flow |
| QuickPass app for the gate | **Todo** | A second guard-side app for rapid scanning |
| **Screenshot protection — animated QR** | **Todo** | Stops a forwarded screenshot being reused. Cheap, and it closes a real hole in every QR system including ours |
| Visitor photo in the notification | **Todo** | Photo capture exists in the guard app design; not wired to the push |
| Facial recognition attendance | **Todo** | Phase 4, opt-in only, per our DPDP position |
| ANPR, boom barrier, eSSL biometric, access-control devices | **Todo** | Phase 4 integrations. Sales notes name Parkples and Parksmark as their barrier partners |
| Voice assistance for guards | **Todo** | |
| Resident↔guard calling (e-intercom) | **Todo** | See Prime |

### 2.2 Prime module — community operations

| # | MyGate feature | WatchMyGate | Note |
|---|---|---|---|
| 1 | *(Standard included)* | — | |
| 2 | Helpdesk / complaint management | **Done** | SLA timers, escalation, proof-of-fix, reopen, rating |
| 3 | Amenity booking | **Done** | Overlap refused by a Postgres exclusion constraint, not an application check |
| 4 | Communication | **Partial** | Notices done; SMS/WhatsApp/email senders still stubbed |
| 5 | Home planner | **Todo** | Low value. Effectively a to-do list for home services |
| 6 | Rent-a-parking | **Todo** | Peer-to-peer slot rental between residents. We store a monthly rate but have no rental flow |
| 7 | SOS alert | **Done** | No role check on raising — deliberate |
| 8 | e-Intercom (R2R, R2G, G2R calling) | **Todo** | Needs a voice provider. Real gap: guards calling residents is the daily interaction |
| 9 | Vehicle search | **Done** | Console search plus a gate lookup endpoint |
| 10 | IVR calls | **Partial** | Rung 2 of the approval ladder is designed for it. **Blocked on Exotel credentials** |
| 11 | Notice board | **Done** | Draft/publish separated; read receipts |
| 12 | Document uploading | **Todo** | No document repository. Bye-laws, AGM minutes, audited accounts |
| 13 | Surveys | **Partial** | Polls exist. A survey is several questions; ours holds one |
| 14 | Election polls | **Partial** | Voting works. Candidate management, turnout reporting and a result/turnout split do not |
| 15 | Meeting alignment | **Todo** | AGM scheduling, agenda, minutes, quorum |

Beyond the fifteen, from the deck:

| MyGate feature | WatchMyGate | Note |
|---|---|---|
| **Defaulter blocking** — dues unpaid disables visitor approvals, amenity booking, move-in, gate passes, even complaint logging | **Todo** | Commercially their most effective feature and **ethically the most questionable**. See §4 |
| Amenity access control, grouping, cooldown, soft-block, recurring bookings, cancellation charges, utilisation report | **Todo** | A deep set. The soft-block (3-minute payment hold) is a good idea |
| Helpdesk auto-assignment by category and skill | **Todo** | We route by category; not by skill or availability |
| Round-robin assignment by staff presence in the society | **Todo** | Clever — uses gate attendance to decide who is actually on site |
| OTP-based complaint resolution by the technician | **Todo** | The resident's OTP closes the ticket. Stronger than our proof-of-fix photo; we should do both |
| Comment templates for helpdesk staff | **Todo** | |
| Saarthi — a third app for technicians | **Todo** | We have no staff-facing app |
| MIS / SLA / TAT reports by category and assignee | **Partial** | Reports page covers ageing and breaches; not by assignee, and no export |
| Move-in / move-out with configurable approval steps | **Partial** | Occupancy in and out is done; the approval workflow, document collection and dues clearance checks are not |
| Rental agreement storage with expiry status | **Todo** | |
| Custom roles (up to 10) | **Todo** | We ship seven fixed roles |
| Community feed, classes, pet directory, buy & sell, local services directory | **Todo** | Phase 4. Pet vaccination status is a surprisingly good hook |

### 2.3 Elite module — the ERP

This is where MyGate is strongest and where our gap is widest. It is also where our
foundations are better than theirs are likely to be: a genuine double-entry immutable
ledger with `numeric(18,4)` money and DB-enforced controls.

| # | MyGate feature | WatchMyGate | Note |
|---|---|---|---|
| 1 | *(Prime included)* | — | |
| 2 | Guard patrolling | **Todo** | |
| 3 | Invoice generation + late-payment penalty | **Done** | Preview → issue; late fee accrues from the day after due |
| 4 | Utility payment (prepaid meters, 14 vendors) | **Todo** | Per-meter billing exists; no vendor integration |
| 5 | Rent payment | **Partial** | Owner's own merchant destination exists so rent lands with **no commission**. No rent schedule or agreement link |
| 6 | Income & expense analysis | **Partial** | Collections analytics done. The expense side has ledger accounts but no reporting |
| 7 | Asset & inventory management | **Todo** | Register, category, location, condition, audit export |
| 8 | Financial reports | **Todo** | Trial balance, P&L, balance sheet — **derivable from the ledger today, but no endpoints exist** |
| 9 | Flat-wise dues and **advance** details | **Partial** | Dues done. Advance/credit balances are not modelled |
| 10 | Budget maintenance | **Todo** | Budget vs actual by head |
| 11 | Receipt generation | **Partial** | Receipts and allocations exist in the ledger; no PDF |
| 12 | Bank reconciliation | **Partial** | OCR reads a statement into candidates; nothing consumes them yet |
| 13 | MIS report | **Todo** | As a named, exportable pack |
| 14 | Security deposit | **Todo** | Collection, holding, reversal — and MyGate ties it to amenity bookings |
| 15 | Balance sheet & tax reports | **Todo** | Plus GST returns and TDS 194C/194J with Form 26Q |

Beyond the fifteen:

| MyGate feature | WatchMyGate | Note |
|---|---|---|
| PR/PO management with multi-level approval | **Todo** | Purchase request → order → vendor bill → payment, with an approval chain |
| Vendor bill booking and payment history | **Todo** | |
| **Tally-compatible export** | **Todo** | Import is half-built (flats and opening balances); export is not started. This is the switching cost in both directions |
| Audit lock by financial year | **Todo** | We have period locking in the plan, unbuilt. Their framing — "reviewed data cannot be tampered with" — is the right pitch |
| House statement across multiple financial years | **Todo** | |
| Cash & fund flow report | **Todo** | |
| Penalty report and invoice-footer penalty summary | **Todo** | Reduces disputes; cheap to build |
| Bulk payout report — one bank entry per day | **Todo** | Directly eases reconciliation. Depends on Razorpay settlement reporting |
| Side-by-side invoice preview before publishing | **Partial** | We preview one flat. Theirs compares flats before publishing a run |
| 4-milestone billing process | **Todo** | Draft → review → approve → publish |
| Unlimited billing heads / sub-ledgers | **Done** | `charge_types` are per-society data, not code |
| E-invoicing via the GST portal, credit notes | **Todo** | |
| Slab-based penalty configuration | **Partial** | One percentage per month; not slabs |
| In-depth audit logs of manager activity | **Partial** | Immutable audit log exists; no console view |
| Automated dues reminders before and on the due date | **Partial** | Worker exists; senders stubbed |
| B2B / non-member invoicing | **Todo** | |
| Low-stock alerts | **Todo** | Depends on inventory |

### 2.4 Platform claims

| MyGate | WatchMyGate |
|---|---|
| Data on AWS | Neon Postgres, Singapore. Documented residency risk in the plan |
| Backup/DR within **7 days** | Our stated target is RPO 5 min / RTO 1 hr — far better, **and unproven**; the restore drill is still Todo |
| ISO, SSL, firewalls, RSA, vulnerability tests | TLS 1.3, AES-256, RLS at the DB-role level, secrets in Secret Manager. Pen test still Todo |
| GDPR/DPDP ready, role-based access, access logging, retention periods, purpose limitation | Consent ledger and erasure cascade are **Todo** — hard deadline 13 May 2027 |
| Entry/exit retention: **6 months, then deleted** | Not implemented. We should match this explicitly |
| Three apps: resident, admin, guard | Same three. Ours: 77 Dart tests, neither yet run on physical hardware |

---

## 3. Where we are genuinely ahead

Worth stating plainly, because the gap list above is long and it would be easy to read it
as "we are behind on everything."

1. **The gate works with no network.** A pre-approved visitor is verified on the handset
   against a cached society public key in under half a second. Nothing in 120 pages of
   MyGate deck claims this. At an Indian apartment gate on a monsoon evening, this is the
   difference between a product and a demo.
2. **Controls live in the database, not in application code.** Amenity double-booking is
   refused by a Postgres exclusion constraint; attendance and outbox rows cannot be
   deleted; posted journal lines cannot be updated. Their 3-minute "soft block" for
   amenities is an application-level mitigation for exactly the race our constraint makes
   impossible.
3. **We take nothing from a resident's payment.** Their notes show ₹5.9 and ₹11 platform
   fees. Money never touches a WatchMyGate account, which is also why we need no RBI
   payment-aggregator licence.
4. **Three separate relationships to a flat** — billing liability, voting right, app
   access — with bitemporal occupancy. "Who was liable in June?" answers correctly six
   weeks after the tenant left. Every competitor collapses this into one resident field.
5. **Money is a string end to end.** No figure in this product has ever been a JavaScript
   float.

---

## 4. Two things in the deck we should not copy

**Defaulter blocking, as MyGate implements it.** Their deck lists disabling visitor and
delivery approvals, gate passes, move-in/move-out, amenity bookings *and complaint
logging* until dues are cleared. Blocking a resident from **raising a complaint** or from
**having a visitor let in** because they are behind on maintenance is using the security
system as a debt-collection lever against a household — one that may be behind for reasons
a committee knows nothing about. We should build the parts that withhold *discretionary*
benefits (amenity booking, a guest parking slot) and refuse the parts that touch safety,
access to their own home, or the ability to report a fault. That is a product decision to
take deliberately and to state on the pricing page, not a feature to omit quietly.

**"Your data doesn't interest us" alongside an advertising engine.** The brochure carries
a privacy page and, two pages earlier, an advertising engine, an e-commerce platform and a
"phygital campaign" product selling lift posters, standees, gate signage and door tags
inside the society. Both may be lawful. Together they are a positioning we should not
imitate — our landing page already commits to no ads and no data sale, and that promise is
worth more the longer they run both pages in one brochure.

---

## 5. Prioritised gap list

Ordered by what would actually lose us a deal against MyGate, not by size.

| Priority | Gap | Why it ranks here |
|---|---|---|
| 1 | **Financial reports** — trial balance, P&L, balance sheet, house statement | Every committee's auditor asks for these. The ledger already holds the data; only the endpoints and pages are missing. Highest value per hour of work in the whole list |
| 2 | **Tally export** | Import brings a society in; export is what lets their accountant keep working. Refusing to build it is a lock-in tactic and it also loses deals |
| 3 | **Document repository** | Bye-laws, AGM minutes, audited accounts. Trivial to build on the attachment machinery that already exists |
| 4 | **Guard patrolling** | Named in Elite, and the one gate feature a security agency asks about first |
| 5 | **Receipt and invoice PDFs** | A resident who cannot download a receipt does not believe they paid |
| 6 | **Kids checkout** | Small, emotionally central to parents, and a clean differentiator in a demo |
| 7 | **Move-in/move-out workflow** | Approvals, documents, dues clearance. High-churn societies live in this screen |
| 8 | **Security deposit** | Blocks amenity bookings for premium societies |
| 9 | **e-Intercom / resident↔guard calling** | The daily interaction. Needs a voice provider |
| 10 | **Asset & inventory register** | Straightforward, and it is on every RFP |
| 11 | **PR/PO with approval chain** | Where their ERP differentiation actually lives |
| 12 | **Budget vs actual** | An AGM asks for it once a year, loudly |
| 13 | **Animated QR / screenshot protection** | Closes a real hole in our own pass design |
| 14 | **Surveys and proper elections** | Turnout reporting, candidates, result/turnout split |
| 15 | **Entry/exit retention policy** | Match their 6 months. Also a DPDP obligation, so it counts twice |

Everything here is now carried in `BACKLOG.md` with an ID, so nothing on this page can be
lost between passes.
