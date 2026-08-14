# WatchMyGate — Security & Compliance

Status: **design**. Last updated 13 Aug 2026.

Hard deadline driving this document: **DPDP Rules 2025 were notified 13 Nov 2025. Consent Manager
registration opens 13 Nov 2026. Full substantive compliance is due 13 May 2027**, with penalties up
to ₹250 crore. This is dated work, not "eventually".

---

## 1. DPDP Act 2023 / Rules 2025

| Requirement | Implementation | Phase |
|---|---|---|
| Notice before collection | Versioned notice text, hash stored per consent record | 3 |
| Consent | Append-only `consents` table; withdrawal is a new row, never an update | 3 |
| Purpose limitation | Purpose recorded per consent; access paths scoped by purpose | 3 |
| Withdrawal of consent | Endpoint plus downstream propagation to processors | 3 |
| Right to access / portability | Per-person export (JSON + PDF) covering all societies they belong to | 3 |
| Right to correction | Bitemporal occupancy already supports retroactive correction | 1 |
| Right to erasure | PII cascade purge; financial records retained under statutory exemption | 3 |
| Children's data | No under-18 accounts. Minors recorded as unit members with no app access | 1 |
| Breach notification | Incident runbook + Data Protection Board notification workflow | 3 |
| Data Protection Officer | Named contact published in-app and on the website | 3 |
| Processor agreements | DPAs with Razorpay, MSG91, Exotel, Meta, Cloudflare, Google, Anthropic | 0 |
| Security safeguards | §4 below | 0–3 |

### Sensitive data: biometrics and facial recognition

Domestic staff cannot meaningfully refuse an employer's demand, so consent has to be structurally
real rather than a checkbox:

- Biometric attendance is **opt-in**, with a **PIN or card alternative always offered** and equally
  prominent in the UI.
- Templates are **irreversible** and held at the edge device. No centrally stored face images.
- A society may not disable the non-biometric alternative. This is enforced in code, not policy.
- Separate consent record, separate purpose, independently withdrawable.

### Erasure design

Erasure must be designed before launch, not retrofitted.

| Data | On erasure request |
|---|---|
| Profile, phone, email, photos | Deleted |
| Gate event photos | Deleted; event row retained with person reference nulled |
| Complaint text and attachments | Deleted |
| Chat, forum posts | Deleted or anonymised at the author's choice |
| Invoices, receipts, journal entries | **Retained** — statutory books of account. Person reference replaced with a pseudonymous token |
| Audit log | Retained; actor reference pseudonymised |

The retention of financial records under a legal obligation is an explicit DPDP exemption, and the
notice text must say so plainly rather than promising deletion we cannot perform.

### Data residency

Primary data store is **Neon Postgres in Singapore**; photos and documents are in **Cloudflare R2**.

This is **legal today** — DPDP imposes no blanket localisation requirement. Two risks are carried
knowingly:

1. **DPDP §16** permits the government to notify countries to which transfer is restricted. If
   Singapore were ever notified, this becomes a forced migration under time pressure. Mitigation:
   Neon → any Postgres is a dump/restore, so the exit is days rather than months. Keep it exercised
   as part of the quarterly restore drill.
2. **RBI payment-data localisation** binds authorised payment system operators — that is Razorpay,
   not us, since we hold no card data and store only references to Razorpay transactions. The
   reading is sound but the ledger does store payment identifiers alongside financial records, so
   **obtain a one-off legal opinion before the 100th society.**

Commercially, "your society's accounts are stored in India" is a line a competitor can use in a
committee meeting and we cannot answer. Worth revisiting at the 100-society mark while migration is
still cheap.

---

## 2. Payments and RBI

- **We are not a payment aggregator and must never become one by accident.** Funds never enter a
  WatchMyGate account in either payment mode. Mode 1 settles via Razorpay Route directly to the
  society's bank; Mode 2 settles to the owner's own merchant account. Any proposal that would have
  us receive and forward money requires a PA licence and must be refused.
- No card data is stored, transmitted or logged. Tokenisation is Razorpay's responsibility.
- Webhook signature verification is mandatory on every inbound event; unsigned events are dropped
  and alerted.
- Third-party gateway credentials (Mode 2) are the most sensitive data in the system — see §4.

---

## 3. TRAI, Aadhaar, GST, state law

**TRAI TCCCPA (SMS).** All SMS requires DLT-registered headers and templates. Template category —
transactional, service-explicit, service-implicit, promotional — is part of the template definition,
not a runtime flag. Only transactional and service-explicit categories may reach numbers on the DND
registry. WhatsApp requires separate opt-in and Meta-approved templates.

**Aadhaar.** Aadhaar Act §57 was struck down; private entities cannot mandate Aadhaar
authentication. **Never store an Aadhaar number.** Staff verification uses DigiLocker or offline
Aadhaar XML, and we persist only the verification *result* plus a masked last-4.

**GST.** Applies to society maintenance only when it exceeds **₹7,500/month per member** *and*
society turnover exceeds **₹20 lakh**. Encoded as a rule in `charge_types` and the state rule-pack —
never hardcoded. Rent between individuals is outside GST.

**TDS.** Vendor payments attract 194C/194J; Form 26Q data must be exportable. Rent above
**₹50,000/month** attracts 194-IB at 5%, deducted by the tenant — surfaced in the payment screen
when Mode 2 is used for rent. We do not deduct or file on anyone's behalf.

**State cooperative law.** Billing heads, AGM procedure and election rules differ by state
(Maharashtra MCS Act and Model Bye-laws 2014; Karnataka KAOA/KSCA; RERA-registered AOAs). Implemented
as a **state rule-pack** keyed on `societies.state_code`.

**E-voting.** Position as "bye-law compliant e-voting with a full audit trail". Never claim blanket
legal validity — validity depends on the society's own bye-laws and its state act.

---

## 4. Security controls

**Transport and storage.** TLS 1.3 everywhere. AES-256 at rest (Neon and R2 defaults). R2 buckets
private, per-society key prefixes, short-lived signed URLs only. Cross-society access returns 404,
never 403 — do not confirm existence.

**Tenant isolation.** Postgres RLS with a `NOBYPASSRLS` application role; unscoped queries return
zero rows rather than everything. The CI cross-tenant leak test is a build gate.

**Authentication.** Phone OTP with rate limiting and lockout. Short-lived access JWTs plus rotating
refresh tokens with reuse detection. **Mandatory TOTP 2FA** for accountant, society admin, auditor
and super admin. Guard app sessions are bound to an admin-registered device ID and revocable.

**Secrets.** Google Secret Manager only. Nothing in code, environment files in the repo, or logs.
Mode 2 gateway credentials: one secret per destination, decrypted in memory for a single request,
never cached, never returned by any API, readable only as a masked last-4, rotation without
downtime, destroyed on offboarding, and every read audit-logged with actor and reason.

**Guard devices.** Society-owned and shared, so the app holds only the current shift's data, purges
resident PII at shift end, encrypts its local store with SQLCipher keyed from Android Keystore, and
can be remotely revoked.

**CCTV and attachments.** Default 30-day retention cap. Every access requires a logged reason.

**Pipeline.** Dependency and container scanning on every build; secret scanning pre-commit; SAST in
CI. Third-party penetration test before the 26th society. Quarterly restore drills against **RPO 5
minutes / RTO 1 hour** — a backup never restored is not a backup.

**AI boundaries.** No AI in the deny path, ever. Anomaly detection runs on aggregate, non-personal
signals — failed-entry bursts at a gate, billing irregularities — and only flags to the committee.
Automated profiling of delivery workers and domestic staff is a DPDP significant-harm exposure and is
wrong on the merits.

---

## 5. Pre-launch checklist

- [ ] DPAs signed with all processors
- [ ] Privacy notice and consent flows reviewed by Indian counsel
- [ ] Legal opinion on payment-data residency (before society #100)
- [ ] DLT registration complete for every SMS template
- [ ] WhatsApp templates approved by Meta
- [ ] Penetration test passed, criticals closed (before society #26)
- [ ] Restore drill executed and timed against stated RPO/RTO
- [ ] Cross-tenant leak test green and wired as a required CI check
- [ ] Ledger invariant job running and alerting
- [ ] Incident runbook written, on-call rota defined
