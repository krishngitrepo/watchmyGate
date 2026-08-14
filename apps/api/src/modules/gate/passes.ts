/**
 * Offline-verifiable visitor passes.
 *
 * The single most important property of this product: **a pre-approved visitor gets in
 * with no network at all.**
 *
 * The server signs a compact payload with the society's Ed25519 private key. The guard
 * app caches the matching public key and verifies locally — no lookup, no round trip,
 * no dependence on the barrier having signal, which is the normal condition at an
 * Indian apartment gate rather than the exception.
 *
 * Payload, pipe-delimited then base64url with the signature appended:
 *
 *     v1|passId|societyId|unitId|validFrom|validTo|maxUses|visitorHash|keyVersion
 *
 * The visitor is a **hash**, not a name. The QR gets photographed, forwarded on
 * WhatsApp and left lying around; it must not be a readable disclosure of who is
 * visiting whom. The guard app shows details fetched when it does have signal.
 *
 * Field order and separator are frozen — the Dart verifier reconstructs this exact
 * string, so any change is breaking and must bump PASS_VERSION.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

import { ValidationError } from "../../common/errors.js";

export const PASS_VERSION = "v1";

/** Rotation cadence. Guards cache this many versions so a pass signed just before a
 * rotation still verifies on a device that has not synced. */
export const KEY_ROTATION_DAYS = 7;
export const KEY_CACHE_DEPTH = 3;

export interface PassPayload {
  passId: string;
  societyId: string;
  unitId: string;
  validFrom: Date;
  validTo: Date;
  maxUses: number;
  visitorHash: string;
  keyVersion: number;
}

function canonical(p: PassPayload): Buffer {
  return Buffer.from(
    [
      PASS_VERSION,
      p.passId,
      p.societyId,
      p.unitId,
      String(Math.floor(p.validFrom.getTime() / 1000)),
      String(Math.floor(p.validTo.getTime() / 1000)),
      String(p.maxUses),
      p.visitorHash,
      String(p.keyVersion),
    ].join("|"),
    "utf8",
  );
}

/**
 * Generate a society signing keypair.
 *
 * The private key goes to Secret Manager; only its reference is stored in Postgres.
 * The public key is distributed to guard devices.
 */
export function generateKeypair(): { privatePem: string; publicB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  const privatePem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  // Raw 32-byte public key: DER prefix is a fixed 12 bytes for Ed25519.
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = der.subarray(der.length - 32);

  return { privatePem, publicB64: raw.toString("base64url") };
}

/**
 * Non-reversible visitor identifier embedded in the QR.
 *
 * Salted per pass, so the same visitor produces a different hash each time — two QRs
 * cannot be correlated to reveal that the same person visited twice.
 */
export function visitorHash(name: string, phone: string, salt: string): string {
  return createHash("sha256")
    .update(`${salt}|${name.trim().toLowerCase()}|${phone.trim()}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

export function newSalt(): string {
  return randomBytes(12).toString("base64url");
}

/** Produce the QR string: `<base64url(canonical)>.<base64url(signature)>`. */
export function signPass(payload: PassPayload, privatePem: string): string {
  const key = createPrivateKey(privatePem);
  const body = canonical(payload);
  const signature = edSign(null, body, key);

  return `${body.toString("base64url")}.${signature.toString("base64url")}`;
}

/**
 * Verify a scanned pass against cached public keys. **No network required.**
 *
 * This is the reference implementation; the Dart version in the guard app must produce
 * identical results.
 *
 * Errors are specific on purpose so a guard can tell "expired yesterday" from "not a
 * valid pass" — one is a visitor on the wrong day, the other is worth flagging.
 */
export function verifyPass(
  qrValue: string,
  publicKeys: Record<number, string>,
): PassPayload {
  const [encodedBody, encodedSig] = qrValue.split(".");
  if (!encodedBody || !encodedSig) {
    throw new ValidationError("This QR code is not a valid entry pass.");
  }

  const body = Buffer.from(encodedBody, "base64url");
  const signature = Buffer.from(encodedSig, "base64url");
  const parts = body.toString("utf8").split("|");

  if (parts.length !== 9 || parts[0] !== PASS_VERSION) {
    throw new ValidationError("This entry pass is in an unsupported format.");
  }

  const keyVersion = Number(parts[8]);
  const publicB64 = publicKeys[keyVersion];
  if (!publicB64) {
    // The device has not synced recently enough to hold the signing key.
    throw new ValidationError(
      "This pass cannot be checked offline. Connect and try again.",
    );
  }

  // Rebuild SPKI DER around the raw key so Node can import it.
  const raw = Buffer.from(publicB64, "base64url");
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });

  if (!edVerify(null, body, key, signature)) {
    throw new ValidationError("This entry pass is not genuine.");
  }

  return {
    passId: parts[1]!,
    societyId: parts[2]!,
    unitId: parts[3]!,
    validFrom: new Date(Number(parts[4]) * 1000),
    validTo: new Date(Number(parts[5]) * 1000),
    maxUses: Number(parts[6]),
    visitorHash: parts[7]!,
    keyVersion,
  };
}

/**
 * Time-window check, kept separate from signature verification.
 *
 * The guard app must distinguish "forged" from "expired": one is a security event worth
 * flagging to the committee, the other is a visitor who turned up on the wrong day.
 */
export function checkValidity(payload: PassPayload, at: Date): void {
  if (at < payload.validFrom) {
    throw new ValidationError(
      `This pass is not valid until ${payload.validFrom.toLocaleString("en-IN")}.`,
    );
  }
  if (at > payload.validTo) {
    throw new ValidationError(
      `This pass expired on ${payload.validTo.toLocaleString("en-IN")}.`,
    );
  }
}
