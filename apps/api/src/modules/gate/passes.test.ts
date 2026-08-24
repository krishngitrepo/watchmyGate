/**
 * Pass signing and offline verification.
 *
 * These run without a database or any cloud account, because the whole point of the
 * design is that verification needs nothing but the payload and a cached public key.
 */

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ValidationError } from "../../common/errors.js";
import {
  ROLLING_STEP_SECONDS,
  checkValidity,
  generateKeypair,
  newSalt,
  rollingCounter,
  signPass,
  signRollingProof,
  verifyPass,
  visitorHash,
  type PassPayload,
} from "./passes.js";

function samplePayload(overrides: Partial<PassPayload> = {}): PassPayload {
  return {
    passId: randomUUID(),
    societyId: randomUUID(),
    unitId: randomUUID(),
    validFrom: new Date("2026-08-14T06:00:00Z"),
    validTo: new Date("2026-08-14T18:00:00Z"),
    maxUses: 1,
    visitorHash: visitorHash("Ravi Kumar", "+919900000009", newSalt()),
    keyVersion: 3,
    ...overrides,
  };
}

describe("offline verification", () => {
  it("verifies a genuine pass with only the cached public key", () => {
    const { privatePem, publicB64 } = generateKeypair();
    const payload = samplePayload();

    const qr = signPass(payload, privatePem);
    const verified = verifyPass(qr, { 3: publicB64 });

    expect(verified.passId).toBe(payload.passId);
    expect(verified.unitId).toBe(payload.unitId);
    expect(verified.visitorHash).toBe(payload.visitorHash);
    expect(verified.validTo.getTime()).toBe(payload.validTo.getTime());
  });

  it("rejects a pass signed by a different society", () => {
    const societyA = generateKeypair();
    const societyB = generateKeypair();

    const qr = signPass(samplePayload(), societyA.privatePem);

    expect(() => verifyPass(qr, { 3: societyB.publicB64 })).toThrow(
      /not genuine/i,
    );
  });

  it("rejects a tampered payload", () => {
    const { privatePem, publicB64 } = generateKeypair();
    const qr = signPass(samplePayload({ maxUses: 1 }), privatePem);

    // Flip the signed body: someone editing the QR to grant more entries.
    const [body, sig] = qr.split(".");
    const decoded = Buffer.from(body!, "base64url").toString("utf8");
    const tampered = Buffer.from(decoded.replace("|1|", "|99|"), "utf8").toString(
      "base64url",
    );

    expect(() => verifyPass(`${tampered}.${sig}`, { 3: publicB64 })).toThrow(
      ValidationError,
    );
  });

  it("tells the guard when the device has not synced the signing key", () => {
    const { privatePem } = generateKeypair();
    const qr = signPass(samplePayload({ keyVersion: 9 }), privatePem);

    // Device holds versions 5–7; the pass was signed with 9.
    expect(() => verifyPass(qr, { 5: "x", 6: "y", 7: "z" })).toThrow(
      /cannot be checked offline/i,
    );
  });

  it("rejects a malformed QR rather than crashing", () => {
    const { publicB64 } = generateKeypair();
    for (const bad of ["", "not-a-pass", "onlyonepart", "a.b"]) {
      expect(() => verifyPass(bad, { 3: publicB64 })).toThrow(ValidationError);
    }
  });
});

describe("validity window is separate from authenticity", () => {
  const payload = samplePayload();

  it("accepts a pass inside its window", () => {
    expect(() =>
      checkValidity(payload, new Date("2026-08-14T12:00:00Z")),
    ).not.toThrow();
  });

  it("distinguishes 'not yet valid' from 'expired'", () => {
    expect(() => checkValidity(payload, new Date("2026-08-14T05:00:00Z"))).toThrow(
      /not valid until/i,
    );
    expect(() => checkValidity(payload, new Date("2026-08-15T00:00:00Z"))).toThrow(
      /expired/i,
    );
  });
});

describe("visitor privacy", () => {
  it("does not put the visitor's name or number in the QR", () => {
    const { privatePem } = generateKeypair();
    const salt = newSalt();
    const payload = samplePayload({
      visitorHash: visitorHash("Ravi Kumar", "+919900000009", salt),
    });

    const decoded = Buffer.from(
      signPass(payload, privatePem).split(".")[0]!,
      "base64url",
    ).toString("utf8");

    expect(decoded).not.toContain("Ravi");
    expect(decoded).not.toContain("9900000009");
  });

  it("produces a different hash per pass, so two QRs cannot be correlated", () => {
    const first = visitorHash("Ravi Kumar", "+919900000009", newSalt());
    const second = visitorHash("Ravi Kumar", "+919900000009", newSalt());
    expect(first).not.toBe(second);
  });
});


/**
 * The screenshot hole, and its fix.
 *
 * v1 is cryptographically sound and completely defeated by a photograph: the bytes being
 * verified are exactly the bytes in the picture. These tests exist to prove the fix does
 * what it claims and, just as importantly, that v1 is honestly reported as weak rather
 * than being quietly treated as safe.
 */
describe("screenshot protection", () => {
  function rollingPass(overrides: Partial<PassPayload> = {}) {
    const society = generateKeypair();
    const holder = generateKeypair();
    const payload = samplePayload({ holderPublicKey: holder.publicB64, ...overrides });
    const staticQr = signPass(payload, society.privatePem);

    return {
      payload,
      keys: { [payload.keyVersion]: society.publicB64 },
      /** What the resident's screen shows during a given window. */
      display(counter: number) {
        const proof = signRollingProof(payload.passId, counter, holder.privatePem);
        return `${staticQr}.${counter}.${proof}`;
      },
    };
  }

  it("accepts a pass shown live from the app", () => {
    const pass = rollingPass();
    const now = Date.parse("2026-08-14T09:00:00Z") / 1000;

    const result = verifyPass(pass.display(rollingCounter(now)), pass.keys, {
      nowSeconds: now,
    });

    expect(result.passId).toBe(pass.payload.passId);
    expect(result.screenshotProof).toBe(true);
  });

  it("refuses a screenshot taken two minutes ago", () => {
    const pass = rollingPass();
    const taken = Date.parse("2026-08-14T09:00:00Z") / 1000;
    // The forwarded image still contains a perfectly valid society signature. That is
    // the whole point — authenticity was never the thing that was broken.
    const forwarded = pass.display(rollingCounter(taken));

    expect(() =>
      verifyPass(forwarded, pass.keys, { nowSeconds: taken + 120 }),
    ).toThrow(ValidationError);
  });

  it("tolerates a little clock error either way", () => {
    const pass = rollingPass();
    const now = Date.parse("2026-08-14T09:00:00Z") / 1000;

    for (const offset of [-ROLLING_STEP_SECONDS, 0, ROLLING_STEP_SECONDS]) {
      const shown = pass.display(rollingCounter(now + offset));
      expect(verifyPass(shown, pass.keys, { nowSeconds: now }).screenshotProof).toBe(true);
    }
  });

  it("refuses a proof signed by the wrong holder", () => {
    const pass = rollingPass();
    const impostor = generateKeypair();
    const now = Date.parse("2026-08-14T09:00:00Z") / 1000;
    const counter = rollingCounter(now);

    // Someone who has the QR image and forges a fresh-looking proof with their own key.
    const forged = signRollingProof(pass.payload.passId, counter, impostor.privatePem);
    const staticQr = pass.display(counter).split(".").slice(0, 2).join(".");

    expect(() =>
      verifyPass(`${staticQr}.${counter}.${forged}`, pass.keys, { nowSeconds: now }),
    ).toThrow(ValidationError);
  });

  it("refuses a v2 pass presented without a live proof", () => {
    const pass = rollingPass();
    const now = Date.parse("2026-08-14T09:00:00Z") / 1000;
    const staticOnly = pass.display(rollingCounter(now)).split(".").slice(0, 2).join(".");

    // Stripping the proof must not degrade to a v1-style accept, which would make the
    // whole mechanism opt-out for an attacker.
    expect(() => verifyPass(staticOnly, pass.keys, { nowSeconds: now })).toThrow(
      ValidationError,
    );
  });

  it("reports a v1 pass as not screenshot-proof rather than failing it", () => {
    const { privatePem, publicB64 } = generateKeypair();
    const payload = samplePayload();
    const qr = signPass(payload, privatePem);

    const result = verifyPass(qr, { [payload.keyVersion]: publicB64 });

    // Still genuine, still admitted — societies have passes in circulation. But the
    // guard app can now tell the difference, and so can a security audit.
    expect(result.passId).toBe(payload.passId);
    expect(result.screenshotProof).toBe(false);
  });

  it("falls back honestly when the device clock cannot be trusted", () => {
    const pass = rollingPass();
    const now = Date.parse("2026-08-14T09:00:00Z") / 1000;

    // A handset that has never synced has no idea what time it is. Rolling verification
    // is impossible, so it must say so rather than accept a screenshot while appearing
    // to be protected.
    const result = verifyPass(pass.display(rollingCounter(now)), pass.keys, {
      clockUntrusted: true,
    });

    expect(result.screenshotProof).toBe(false);
  });
});
