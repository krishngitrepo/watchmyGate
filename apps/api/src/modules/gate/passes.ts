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
 *
 * ---
 *
 * ## v2: the screenshot problem
 *
 * v1 has a hole, and it is ours rather than inherited: **a photograph of the QR works.**
 * A guest screenshots their pass, forwards it on WhatsApp, and whoever holds that image
 * opens the gate for as long as the pass is valid. Everything about v1 is
 * cryptographically sound and none of it helps, because the bytes being verified are
 * exactly the bytes in the picture.
 *
 * v2 adds a **holder key**. The resident's app generates an Ed25519 keypair, registers
 * the public half, and the server signs that public key *into* the pass. The displayed
 * QR then carries a short-lived proof:
 *
 *     v2|passId|societyId|unitId|validFrom|validTo|maxUses|visitorHash|keyVersion|holderPub
 *     …then `.societySig.counter.holderSig`
 *
 * `counter` is the 30-second window number and `holderSig` is the holder's signature
 * over `passId|counter`. A screenshot therefore contains a proof that is worthless
 * within about a minute.
 *
 * The property that makes this work at a gate with no signal: because the *society*
 * signed the holder's public key, the guard needs no lookup to trust it. One
 * verification chain, entirely offline.
 *
 * ### The clock problem, stated honestly
 *
 * This depends on time, and this product's stated position is that **a guard handset's
 * clock is not trusted** — that is why every gate event records device time, server time
 * and the drift between them. A device hours out of true would reject every valid pass.
 *
 * So the verifier takes a `driftSeconds` correction, which the guard app already
 * computes at sync. A device that has never synced cannot do rolling verification at
 * all; it falls back to v1 static checking and says so, rather than silently accepting a
 * screenshot while appearing to be protected.
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
export const PASS_VERSION_ROLLING = "v2";

/** Rotation cadence. Guards cache this many versions so a pass signed just before a
 * rotation still verifies on a device that has not synced. */
export const KEY_ROTATION_DAYS = 7;
export const KEY_CACHE_DEPTH = 3;

/**
 * How long a displayed proof is good for.
 *
 * Thirty seconds, with one step of tolerance either side, so a genuine pass survives
 * roughly a minute and a half of combined clock error and a guard fumbling the scan.
 * Shorter would start rejecting real visitors at a barrier in the rain; longer would
 * give a forwarded screenshot a usable life.
 */
export const ROLLING_STEP_SECONDS = 30;
export const ROLLING_TOLERANCE_STEPS = 1;

export interface PassPayload {
  passId: string;
  societyId: string;
  unitId: string;
  validFrom: Date;
  validTo: Date;
  maxUses: number;
  visitorHash: string;
  keyVersion: number;
  /** Present only on v2. The resident device's Ed25519 public key, base64url raw. */
  holderPublicKey?: string;
}

/** What the guard learns beyond "is this genuine". */
export interface VerifiedPass extends PassPayload {
  /**
   * True only when a live holder proof was checked.
   *
   * A v1 pass verifies perfectly and is **not** screenshot-proof. Saying so lets the
   * guard app show the difference, and lets a society see how much of its estate is
   * still on the weak format.
   */
  screenshotProof: boolean;
}

function canonical(p: PassPayload): Buffer {
  const rolling = p.holderPublicKey !== undefined && p.holderPublicKey !== "";

  const fields = [
    rolling ? PASS_VERSION_ROLLING : PASS_VERSION,
    p.passId,
    p.societyId,
    p.unitId,
    String(Math.floor(p.validFrom.getTime() / 1000)),
    String(Math.floor(p.validTo.getTime() / 1000)),
    String(p.maxUses),
    p.visitorHash,
    String(p.keyVersion),
  ];
  if (rolling) fields.push(p.holderPublicKey!);

  return Buffer.from(fields.join("|"), "utf8");
}

/** The 30-second window a proof belongs to. */
export function rollingCounter(nowSeconds: number = Date.now() / 1000): number {
  return Math.floor(nowSeconds / ROLLING_STEP_SECONDS);
}

/**
 * What the resident's device signs, once per window.
 *
 * Deliberately just the pass id and the counter. Signing more would leak more into a
 * value that is displayed as a QR many times a day, and nothing else is needed: the
 * static half of the pass is already covered by the society's signature.
 */
export function rollingProofBody(passId: string, counter: number): Buffer {
  return Buffer.from(`${passId}|${counter}`, "utf8");
}

/** Reference implementation of what the resident app does. Mirrored in Dart. */
export function signRollingProof(
  passId: string,
  counter: number,
  holderPrivatePem: string,
): string {
  const key = createPrivateKey(holderPrivatePem);
  return edSign(null, rollingProofBody(passId, counter), key).toString("base64url");
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
  options: {
    /** Seconds since epoch, already corrected for this device's known drift. */
    nowSeconds?: number;
    /**
     * True when the device has never synced and therefore has no trustworthy clock.
     * Rolling proofs are skipped and the result says `screenshotProof: false` — an
     * honest downgrade rather than a silent one.
     */
    clockUntrusted?: boolean;
  } = {},
): VerifiedPass {
  const segments = qrValue.split(".");
  const [encodedBody, encodedSig] = segments;
  if (!encodedBody || !encodedSig) {
    throw new ValidationError("This QR code is not a valid entry pass.");
  }

  const body = Buffer.from(encodedBody, "base64url");
  const signature = Buffer.from(encodedSig, "base64url");
  const parts = body.toString("utf8").split("|");

  const version = parts[0];
  const rolling = version === PASS_VERSION_ROLLING;

  if (
    (version !== PASS_VERSION && !rolling) ||
    (version === PASS_VERSION && parts.length !== 9) ||
    (rolling && parts.length !== 10)
  ) {
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

  const payload: PassPayload = {
    passId: parts[1]!,
    societyId: parts[2]!,
    unitId: parts[3]!,
    validFrom: new Date(Number(parts[4]) * 1000),
    validTo: new Date(Number(parts[5]) * 1000),
    maxUses: Number(parts[6]),
    visitorHash: parts[7]!,
    keyVersion,
    ...(rolling ? { holderPublicKey: parts[9]! } : {}),
  };

  // A v1 pass is genuine and reproducible from a photograph. Nothing more to check.
  if (!rolling) return { ...payload, screenshotProof: false };

  // The society signed the holder's public key into the body above, so it is trusted
  // without a lookup — which is what keeps this working with no network.
  if (options.clockUntrusted) {
    return { ...payload, screenshotProof: false };
  }

  const [, , encodedCounter, encodedProof] = segments;
  if (!encodedCounter || !encodedProof) {
    throw new ValidationError(
      "This pass needs to be shown from the resident's app, not from a screenshot.",
    );
  }

  const presented = Number(encodedCounter);
  if (!Number.isInteger(presented)) {
    throw new ValidationError("This entry pass is in an unsupported format.");
  }

  const expected = rollingCounter(options.nowSeconds ?? Date.now() / 1000);
  if (Math.abs(presented - expected) > ROLLING_TOLERANCE_STEPS) {
    // The commonest cause by far is a forwarded screenshot, so the message names it —
    // a guard reading "expired" would try rescanning the same picture.
    throw new ValidationError(
      "This code has expired. Ask the visitor to show the live pass in their app.",
    );
  }

  const holderRaw = Buffer.from(payload.holderPublicKey!, "base64url");
  const holderSpki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    holderRaw,
  ]);
  const holderKey = createPublicKey({
    key: holderSpki,
    format: "der",
    type: "spki",
  });

  const proofOk = edVerify(
    null,
    rollingProofBody(payload.passId, presented),
    holderKey,
    Buffer.from(encodedProof, "base64url"),
  );
  if (!proofOk) {
    throw new ValidationError("This entry pass is not genuine.");
  }

  return { ...payload, screenshotProof: true };
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
