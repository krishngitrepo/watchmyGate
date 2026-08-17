# WatchMyGate — Basic and Pro

Two plans, not three. Everything MyGate splits across Standard, Prime and Elite is packed
into these two, and the split is drawn where a society's own decision actually falls.

Feature-by-feature provenance is in [`COMPETITOR_MYGATE.md`](COMPETITOR_MYGATE.md).
Delivery status is in [`../BACKLOG.md`](../BACKLOG.md).

---

## 1. Why two, and where the line goes

MyGate's three tiers separate the gate (Standard), community operations (Prime) and
accounting (Elite). In practice a society buying Prime without Elite is running its money
in Tally or a spreadsheet anyway — which means MyGate is selling the same society twice
and the middle tier exists mainly to make the top one look reasonable.

The real decision a committee makes is binary: **do we want this to run the gate, or do we
want it to run the society?** So:

- **Basic** — everything at and around the gate, plus the community operations that make
  the app worth opening: complaints, notices, amenities, polls. MyGate's Standard *and*
  most of Prime.
- **Pro** — Basic, plus the money: invoicing, the ledger, collections, financial reports,
  budgets, assets, procurement. MyGate's Elite.

A society on Basic that later wants Pro pays the difference and keeps its data. There is
no migration, no re-onboarding, and no separate app — the pages are already there, greyed
with a line saying what they would do.

---

## 2. What is in each plan

`Live` = built and covered by a test. `Building` = in progress. `Planned` = committed,
with a backlog ID. Nothing is listed here that is not in `BACKLOG.md`.

### Basic

**The gate**

| Feature | Status |
|---|---|
| Visitor entry and exit, with photo capture | Live |
| **Pre-approved passes that verify with no network** | Live |
| Approval ladder — push → IVR → standing rule → committee | Live *(IVR needs Exotel)* |
| Delivery and parcel management, gate to doorstep | Live |
| Proof of handover — a parcel cannot be marked delivered without naming who took it | Live |
| Daily help and staff management | Live |
| Attendance — PIN, card, gate scan, manual; biometric opt-in with a PIN always offered | Live |
| Vehicle register and gate plate lookup | Live |
| Parking slots and allotment | Live |
| Unauthorised-parking flagging | Live |
| Overstay alerts | Live |
| SOS — medical, fire, gas, security | Live |
| Entry/exit log with clock-drift tracking | Live |
| Kids checkout | Planned |
| Digital register — replaces the gate book, exports to Excel | Planned |
| Guard patrolling with geofenced check-ins | Planned |
| Screenshot-proof animated passes | Planned |
| Frequent-visitor list and one-click re-invite | Planned |
| Offline emergency contact directory | Planned |
| Resident ↔ guard calling | Planned |

**The community**

| Feature | Status |
|---|---|
| Complaints — categories, SLA timers, auto-escalation | Live |
| Threaded updates, internal notes, proof-of-fix, rating, 7-day reopen | Live |
| Notices, circulars and events with targeted audiences | Live |
| DLT-compliant messaging — refuses a channel the law does not allow | Live |
| Polls with one vote per person, enforced by the database | Live |
| Amenity booking — double-booking refused by Postgres, not by a check | Live |
| Flats, towers, and residents with owner/tenant/family distinctions | Live |
| Roles and directory | Live |
| Reports — footfall, complaint ageing, SLA breaches, staff | Live |
| **Data import from Tally, Excel or a competitor** | Live *(flats and opening balances)* |
| 8 regional languages in the resident and guard apps | Live |
| Document repository — bye-laws, minutes, audited accounts | Planned |
| Surveys and committee elections with turnout reporting | Planned |
| Move-in / move-out workflow with approvals | Planned |
| Neighbour directory with privacy controls | Planned |
| AGM scheduling, agenda and minutes | Planned |

### Pro

Everything in Basic, plus:

| Feature | Status |
|---|---|
| Invoicing — per flat, per sq ft, per BHK, metered, sinking fund | Live |
| Preview before issuing, computed by the same code that issues | Live |
| GST rule engine — applies only above ₹7,500/member/month **and** ₹20L turnover | Live |
| Late fees and interest | Live |
| **Double-entry immutable ledger** — posted lines cannot be edited, by database grant | Live |
| Receipts and allocation against invoices | Live |
| Dues and defaulter tracking with ageing buckets | Live |
| **Collections settle directly to the society's bank. Never to us** | Live *(needs Razorpay keys)* |
| Per-unit virtual accounts so NEFT/UPI auto-reconciles | Live *(needs Razorpay keys)* |
| Manual receipts — cash, cheque, matched NEFT | Live |
| Rent collection to a flat owner's own merchant, **zero commission** | Live |
| Opening balances imported exact to the paisa | Live |
| Financial reports — trial balance, P&L, balance sheet | Planned |
| House statement across financial years | Planned |
| Cash and fund flow report | Planned |
| Invoice and receipt PDFs | Planned |
| **Tally-compatible export** | Planned |
| Budget vs actual by head | Planned |
| Asset and inventory register | Planned |
| Purchase requests and orders with an approval chain | Planned |
| Vendor bills and payment history | Planned |
| Security deposits — collection, holding, reversal | Planned |
| Advance and credit balances per flat | Planned |
| Penalty report and invoice-footer penalty summary | Planned |
| Period lock after committee sign-off | Planned |
| GST returns, TDS 194C/194J, Form 26Q | Planned |
| Bank statement reading (OCR) into reconciliation candidates | Live *(needs Anthropic key)* |
| Utility and prepaid-meter integration | Planned |

---

## 3. Pricing

### What MyGate actually charges

From the sales notes, for a **171-villa community, 3 gates, 10 acres**:

| MyGate plan | Annual | + 18% GST | Per unit / month |
|---|---|---|---|
| Standard (visitor management) | ₹28,000 | ₹33,040 | ₹13.6 |
| Prime | ₹32,000 | ₹37,760 | ₹15.6 |
| Elite | ₹42,000 | ₹49,560 | ₹20.5 |

No one-time fee. Training is online only and must be completed within 10 days. Guard
retraining is charged separately when security staff change.

Two things about that table matter more than the numbers.

**It is priced per society, not per flat.** The same ₹42,000 buys Elite for 171 villas or
for 800 flats. So their effective price collapses as a society grows — around ₹20.5 per
unit per month at 171 units, and about ₹4.40 at 800. A large society is getting a bargain
and a small one is subsidising it.

**Residents pay a separate platform fee on every payment** — ₹5.9 and ₹11 appear in the
notes against Razorpay. On 171 units paying monthly, an ₹11 fee is roughly ₹22,500 a year
taken from residents, on top of what the society pays. That is more than half the Elite
licence again, and it does not appear on any slide.

### What we charge

Per flat, tapering with size, with an **annual ceiling** so a large society is never
punished for being large.

| | Basic | Pro |
|---|---|---|
| First 100 flats | ₹10 / flat / month | ₹16 / flat / month |
| Flats 101–300 | ₹7 | ₹11 |
| Flats above 300 | ₹4 | ₹6 |
| Minimum | ₹1,200 / month | ₹2,000 / month |
| **Annual ceiling** | **₹24,000** | **₹36,000** |
| Setup, migration, training | ₹0 | ₹0 |
| Fee on a resident's payment | **₹0** | **₹0** |

All figures exclusive of 18% GST, as MyGate's are.

### Side by side

| Society size | Our Basic | MyGate Standard | Our Pro | MyGate Elite |
|---|---|---|---|---|
| 60 flats | ₹14,400 | ₹28,000 | ₹24,000 | ₹42,000 |
| **171 villas** *(the quoted community)* | **₹17,964** | **₹28,000** | **₹28,572** | **₹42,000** |
| 300 flats | ₹24,000 *(ceiling)* | ₹28,000 | ₹36,000 *(ceiling)* | ₹42,000 |
| 600 flats | ₹24,000 *(ceiling)* | ₹28,000 | ₹36,000 *(ceiling)* | ₹42,000 |

Cheaper at every size, and materially cheaper for the small societies MyGate's flat fee
penalises hardest — which is also where a founder-led sale can actually reach the
committee.

**The ceiling is deliberate and it costs us.** A 600-flat society on Pro pays ₹5 per flat
per month. We could charge more and still undercut. We do not, because the two things that
decide this business are onboarding cost and support load per society, and both are close
to flat with size. Charging for flats we do not cost more to serve is how a per-seat price
turns into a reason to leave.

### Margin check

Against the plan's cost model: ~₹5–7 lakh a month of infrastructure at 1,000 societies.
At an average of ₹28,000 a year blended across Basic and Pro, 1,000 societies is
₹2.8 crore a year, or about ₹23.3 lakh a month — a **70–74% gross margin**. That is a few
points below the 72–78% the original plan assumed, and the ceiling is where the difference
goes. It is worth it: the alternative is charging large societies more for a service that
costs the same to run, which is the pricing that makes them leave.

---

## 4. What no plan includes

Stated here because it is a commitment, not an omission.

- **No advertising.** No lift posters, no gate signage, no door tags, no sampling kiosks,
  no "phygital campaigns" inside the society. MyGate's brochure sells all of these two
  pages after a page titled "Your data doesn't interest us."
- **No data sale, ever**, and no resident profiling. Anomaly detection runs on aggregate,
  non-personal signals and only ever flags to the committee.
- **No fee on a resident's payment.** UPI is 0% by RBI mandate and is offered first. The
  gateway's own charges on cards and netbanking still apply and are shown as the
  gateway's.
- **We never hold society money.** Collections settle straight to the society's bank
  account. This is what keeps us out of RBI payment-aggregator licensing, and it means a
  society's funds cannot be caught up in anything that happens to us.
- **No AI decides who gets in.** A model can suggest; a person decides.
- **No cutting off a household's safety or access over unpaid dues.** MyGate's deck lists
  blocking visitor approvals, gate passes, move-in/move-out and *complaint logging* until
  arrears are cleared. We will withhold discretionary benefits — booking the party hall, a
  guest parking slot — and we will not touch a resident's ability to get into their own
  home, have a visitor let in, or report a fault. A society that wants a debt-collection
  lever has ordinary legal ones.

---

## 5. Open commercial questions

Decisions for Krishna, listed because the answers change the pricing page rather than the
code.

1. **Introductory pricing for the first 25 societies.** These are the societies that find
   the bugs. A 50% first-year discount in exchange for a reference and a case study is
   normal and probably right.
2. **Hardware.** MyGate integrates boom barriers, ANPR and eSSL biometrics — their notes
   name Parkples and Parksmark. The plan's decision was software-only until 50 societies.
   That still holds, but at some point "we do not sell hardware" becomes "we do not
   support your existing barrier", which is a different and worse sentence.
3. **Guard retraining.** MyGate charges for it when security staff change, which for an
   agency-staffed society is several times a year. Bundling it is a small cost and a good
   line in a pitch.
4. **Basic → Pro upgrade pricing.** Recommend a straight pro-rata difference with no
   penalty. The upgrade is the whole business model; nothing should slow it down.
