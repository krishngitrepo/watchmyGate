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
  checkValidity,
  generateKeypair,
  newSalt,
  signPass,
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
