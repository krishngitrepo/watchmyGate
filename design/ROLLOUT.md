# WatchMyGate — Rollout Plan

Status: **design**. Last updated 13 Aug 2026.

---

## The market reality this plan is built against

MyGate is at 25,000+ societies. Market pricing is **₹3–15 per flat per month**. At 1,000 societies ×
~250 units × ₹10 that is roughly **₹3 crore ARR**.

The incumbents already have the features. This market is not won on feature count — it is won on
**distribution and switching cost**. Two consequences run through everything below:

1. **Migration tooling is the product.** The reason a committee does not switch is that three years
   of Tally data and resident records live in the incumbent. Whoever makes leaving painless wins.
2. **Support load per society is the growth ceiling.** If support exceeds ~20 minutes per society per
   month, the model breaks before 400 societies regardless of how good the app is.

---

## Revenue model

**Paid SaaS, ₹8–15 per flat per month**, plus commission on marketplace services a resident
explicitly chooses to book. **No ads. No data sale.** This is a deliberate trade: slower growth than
the free-plus-marketplace model, defensible margins, and a privacy story that survives a committee's
questions.

| Stage | Societies | Infra + comms cost | Notes |
|---|---|---|---|
| Pilot | ≤10 | ~₹5,000–9,000/mo | Cloud Run min-instances ≥ 2 (~₹3–5k) is not optional; Neon paid tier with autosuspend off |
| Early | 100 (~25k units) | ~₹40–65k/mo | Against ~₹2.5L/mo revenue |
| Scale | 1,000 (~250k units) | ~₹5–7L/mo | Against ~₹25L/mo revenue ⇒ **~72–78% gross margin** |

Free-tier hosting does not survive contact with this product: keeping the gate responsive requires
warm instances from day one. A guard app that stalls three seconds at the barrier loses the society.

---

## Stage 1 — Societies 1 to 3 (months 1–6)

Hand-picked in Bengaluru, ideally where there is a personal introduction to the committee.

**Full white-glove.** We do the data migration ourselves. We sit at the gate for the first week. We
train the guards in person, in their language. We attend the committee meeting.

The goal is **not revenue** — it is discovering what actually breaks. Expect the failures to be
operational rather than technical: guards who share a login, a committee that changes its billing
formula mid-month, residents who never open the app.

**Exit criteria — all must hold for 30 consecutive days:**
- Zero money discrepancies at month-end close
- Guard app crash-free sessions > 99.5%
- A completed Tally import for each society
- Median complaint resolution time trending down

## Stage 2 — Societies 4 to 25 (months 7–10)

Still founder-led selling. The difference: the society now runs its own migration through the import
tool while we watch, and we fix what confuses them.

**Rule: every support ticket is a product bug until proven otherwise.** This is where the onboarding
playbook gets written from real failures rather than imagination.

## Stage 3 — Societies 26 to 100 (months 11–16)

First salesperson hired. Targets that must hold before scaling further:

- Onboarding completes in **under 48 hours** and under **2 hours of our time**
- Support **under 20 minutes per society per month**

Introduce the **referral motion** — a committee member who moves house, or sits on two committees, is
the single best lead source in this market. Penetration test happens before society #26.

## Stage 4 — Societies 101 to 400 (months 17–28)

**Channel partners.** Facility management companies and builders each control 10–50 societies. One
signed builder is worth months of direct selling. This is why white-label sits in Phase 4 of the
build rather than later — it becomes commercially necessary here.

Legal opinion on payment-data residency lands before society #100 (see `SECURITY_COMPLIANCE.md`).

## Stage 5 — Societies 401 to 1,000 (months 29–42)

Self-serve onboarding, with sales assist reserved for societies above 500 units.

Regional expansion beyond Karnataka requires the **state rule-packs** to be complete — Maharashtra
especially, since MCS Act model bye-laws prescribe billing heads that differ materially from
Karnataka's.

---

## Onboarding a society — the 48-hour target

| Step | Owner | Time |
|---|---|---|
| Committee demo and decision | Sales | — |
| Society record, towers, units created (bulk import) | Society admin | 2 h |
| Resident and occupancy import (Excel/CSV) | Society admin | 3 h |
| Opening balances and Tally ledger import | Accountant | 4 h |
| Razorpay Route KYC submitted | Society admin | 30 min (2–5 days to clear) |
| Charge types and billing formulas configured | Accountant + us | 2 h |
| Gates, guard devices, guard accounts | Facility manager | 2 h |
| Guard training on site | Us (Stage 1–2) / video (Stage 3+) | 3 h |
| Resident invitations sent | Automated | — |
| First test bill run reviewed against the old system | Accountant + us | 2 h |

**The reconciliation step is the one that cannot be skipped.** The first bill run must be compared
line by line against whatever the society used before. A society that finds a ₹50 discrepancy in
month one never trusts the system again.

---

## Support model

| Stage | Channel | Target response |
|---|---|---|
| 1–2 | WhatsApp group per society, direct to us | < 1 hour |
| 3 | In-app support + WhatsApp, one support hire | < 4 hours |
| 4–5 | In-app ticketing, help centre, tiered escalation | < 8 hours |

Deflection is what makes stage 4 possible: a help centre in 8 languages, in-app contextual guidance,
and — the highest-leverage item — an onboarding flow good enough that most societies never need to
ask.

---

## Leading indicators to watch

| Metric | Healthy | Danger |
|---|---|---|
| Support minutes per society per month | < 20 | > 45 |
| Onboarding elapsed time | < 48 h | > 1 week |
| Resident activation (units with ≥1 active app user) | > 70% | < 40% |
| Guard app crash-free sessions | > 99.5% | < 98% |
| Month-end close discrepancies | 0 | any |
| Societies churned per quarter | < 2% | > 5% |

Resident activation is the one that predicts churn earliest. A society where residents never opened
the app renews once out of politeness and then leaves.
