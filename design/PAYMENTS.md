# WatchMyGate — Payment Architecture

Status: **design**. Last updated 13 Aug 2026.

Two collection modes. A society picks one per charge type; both can run side by side in the same
society (e.g. maintenance via Mode 1 to the society account, rent via Mode 2 to each flat owner).

**Non-negotiable across both modes: money never touches a WatchMyGate account.** Collecting funds
on behalf of third parties into our own account would require an RBI Payment Aggregator licence.
Both designs below settle directly to the payee.

---

## Mode 1 — Platform-managed (Razorpay Route)

The default, used for society-level charges: maintenance, amenity fees, sinking fund, penalties.

- Each society is onboarded as a **Razorpay Route linked account**; funds settle **directly to the
  society's own bank account**.
- **Smart Collect** issues a per-unit virtual account number, so NEFT/IMPS/UPI credits
  auto-reconcile to the correct flat with no manual matching.
- We control the webhook, so reconciliation, retries and dues tracking are fully automatic.
- Platform fee configurable per society, **default 0%**. Our SaaS fee is billed separately as an
  ordinary B2B invoice.

**Onboarding cost:** society must complete Razorpay KYC through our Route flow (PAN, bank proof,
society registration certificate). Typically 2–5 working days.

---

## Mode 2 — Direct merchant (bring your own merchant ID)

For payments that belong to an **individual flat owner** rather than the society — primarily **rent
paid by a tenant to their landlord**, and any owner-specific charges.

The owner supplies their **own payment gateway merchant ID and API credentials**. Payments are
created against *their* account, so funds land in their bank with **zero WatchMyGate commission**.
We orchestrate the request and record the result; we are never in the money path.

### Setup flow

1. Owner opens **Settings → Payments → Receive payments directly** in the resident app.
2. Enters **merchant ID**, **key ID** and **key secret** for their own gateway account.
3. We write the secret to **Google Secret Manager** at `pg-credentials/{destination_id}` — never to
   Postgres, never to logs, never returned by any API.
4. We **verify** by creating and immediately voiding a ₹1 order against their credentials. Unverified
   destinations cannot be used.
5. We display a **webhook URL and signing secret** for the owner to paste into their gateway
   dashboard. Without this we cannot confirm payments automatically — see fallback below.
6. Owner assigns which charge types route here (e.g. *Rent*).

### Payment flow

```
Tenant taps Pay Rent
  → API loads the owner's payment_destination
  → decrypts credentials from Secret Manager (in-memory only)
  → creates order via the OWNER's gateway account
  → tenant completes payment
  → funds settle to the OWNER's bank account directly
  → gateway webhook → our endpoint → invoice marked paid → ledger entry written
```

### Data model

```
payment_destinations
  id                    uuid pk
  society_id            uuid            -- RLS scope
  payee_type            enum(society, person)
  payee_id              uuid
  mode                  enum(route_linked, direct_merchant)
  provider              enum(razorpay, cashfree, ...)
  merchant_id           text
  credentials_secret_ref text           -- Secret Manager path, NOT the secret
  webhook_secret_ref    text
  status                enum(pending, verified, failed, disabled)
  verified_at           timestamptz
  created_at, updated_at

charge_type_routing
  society_id, charge_type, destination_id   -- e.g. (soc-1, 'rent', dest-9)
```

---

## What "no commission" does and does not mean

**We take nothing.** Platform commission in Mode 2 is zero by design — we never touch the money.

**The gateway still charges the owner.** Razorpay (or whichever provider) deducts its own MDR from
the owner's settlement regardless of whose merchant account it is. Approximate rates:

| Method | Typical MDR |
|---|---|
| **UPI** | **0%** — RBI mandates zero MDR on UPI P2M |
| Debit card | ~0.4–0.9% |
| Credit card | ~2% + GST |
| Net banking | ~1.5–1.9% + GST |

**Practical consequence:** for rent-sized amounts, default the payment screen to **UPI**, which is
genuinely free for both sides. Show the owner what each method will cost them before they enable it.
Do not describe Mode 2 as "free" in the UI — describe it as "no WatchMyGate fee".

---

## Trade-offs the owner accepts in Mode 2

| Area | Mode 1 (Route) | Mode 2 (direct) |
|---|---|---|
| Platform commission | Configurable, default 0% | Always 0% |
| Gateway MDR | Owner/society pays | Owner pays |
| Reconciliation | Automatic via virtual accounts | Depends on owner configuring our webhook |
| Refunds & disputes | We can assist | Entirely between payer and owner |
| Failed-payment retries | Automatic | Manual |
| Settlement guarantee | Visible to us | Not visible to us |
| KYC | Through our Route flow | Already done with their gateway |

**Reconciliation fallback.** If the owner has not configured the webhook, we cannot confirm payment
automatically. Handle it with a polling job against their gateway's order API every 15 minutes for
24 hours, plus a manual *"I have paid"* flow where the tenant enters the UTR and the owner confirms.
Never mark an invoice paid on the tenant's word alone.

---

## Security requirements (Mode 2)

Storing another party's gateway credentials is the highest-sensitivity data in the product.

- Secrets live **only** in Google Secret Manager, one secret per destination, encrypted at rest.
- Decrypted **in memory only**, for the duration of a single request. Never cached, never logged.
- API responses return `merchant_id` masked to last 4 characters; the secret is never readable back,
  only replaceable.
- Access is audit-logged with actor, timestamp and reason.
- Rotation supported without downtime — new credentials verified before the old are revoked.
- Use **restricted API keys** where the provider supports scoping (orders + payments read only).
- On owner offboarding, the secret is destroyed, not soft-deleted.

---

## Compliance notes

- **RBI:** neither mode makes us a payment aggregator — we never receive or hold funds. This is the
  single most important property of both designs and must not be compromised for convenience.
- **TDS on rent (section 194-IB):** a tenant paying rent above **₹50,000/month** must deduct 5% TDS
  and deposit it. If Mode 2 is used for rent, surface this in the payment screen and record it on the
  receipt. We do not deduct or file on anyone's behalf.
- **Terms of service** must state plainly that in Mode 2 WatchMyGate facilitates a payment between
  two parties and is not a party to it — no liability for settlement, refunds or disputes.
- **GST:** unchanged. Applies to society maintenance only above ₹7,500/month per member *and* ₹20L
  society turnover. Rent between individuals is outside GST.

---

## Open decisions

1. Which providers to support in Mode 2 beyond Razorpay — Cashfree and PhonePe are the obvious next
   two. Recommend launching Razorpay-only and adding others on demand.
2. Whether a society MC may *force* Mode 1 for maintenance and forbid Mode 2 — recommend yes, as a
   society-level policy flag, since maintenance is society income and must land in society books.
