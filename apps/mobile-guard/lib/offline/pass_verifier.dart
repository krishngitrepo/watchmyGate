/// Offline pass verification.
///
/// This file is the product. A pre-approved visitor gets through the gate with **no
/// network at all** — no lookup, no round trip, no dependence on the barrier having
/// signal, which at an Indian apartment gate is the normal condition rather than the
/// exception. No competitor does this cleanly.
///
/// It is a reimplementation of `apps/api/src/modules/gate/passes.ts` and must agree with
/// it exactly. The canonical payload is a pipe-delimited string:
///
///     v1|passId|societyId|unitId|validFrom|validTo|maxUses|visitorHash|keyVersion
///
/// Field order and separator are frozen. `test/golden_vectors_test.dart` runs passes
/// signed by the TypeScript implementation through this verifier, so a divergence fails
/// the build rather than turning up at a gate at 7am.
///
/// Two things this deliberately does not do:
///
/// **It never reaches the network.** Not even to refresh a key. The moment verification
/// can block on a request, the guarantee is gone — a slow network is worse than no
/// network, because the guard waits.
///
/// **It never reveals who is visiting.** The QR carries a salted hash, not a name or a
/// phone number, because a pass gets photographed and forwarded on WhatsApp. Visitor
/// details are fetched separately when the device has signal.
///
/// ## v2 — the screenshot hole
///
/// v1 is cryptographically sound and completely defeated by a photograph: the bytes
/// being verified are exactly the bytes in the picture. A guest screenshots their pass,
/// forwards it, and whoever holds the image opens the gate.
///
/// v2 adds a holder key. The resident's app owns an Ed25519 keypair and the **society**
/// signs its public half into the pass, so this device can trust it with no lookup. The
/// displayed QR then carries a proof over the current 30-second window:
///
///     <body>.<societySig>.<counter>.<holderSig>
///
/// A forwarded screenshot therefore stops working within about a minute.
///
/// ### The clock, which this app already distrusts
///
/// Every gate event here records device time, server time and the drift between them,
/// precisely because these handsets are cheap and shared and their clocks are wrong.
/// Rolling verification needs a clock, so it takes the drift correction the sync engine
/// already computes. A device that has never synced cannot do it at all and reports
/// `screenshotProof: false` rather than pretending — an honest downgrade beats a silent
/// one.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Frozen. Any change to the canonical layout must bump this.
const String passVersion = 'v1';

/// Passes carrying a holder key and a rolling proof.
const String passVersionRolling = 'v2';

/// How long a displayed proof is good for, with one step of slack either side.
///
/// Roughly ninety seconds of combined clock error and fumbling at a barrier in the rain.
/// Shorter starts rejecting real visitors; longer gives a forwarded screenshot a usable
/// life.
const int rollingStepSeconds = 30;
const int rollingToleranceSteps = 1;

/// The window a proof belongs to.
int rollingCounter(DateTime at) =>
    at.toUtc().millisecondsSinceEpoch ~/ 1000 ~/ rollingStepSeconds;

/// Why a pass was refused.
///
/// Specific on purpose. A guard needs to tell "expired yesterday" from "not genuine":
/// the first is a visitor on the wrong day and is resolved by calling the flat, the
/// second is worth flagging to the committee. A single "invalid" would collapse those.
enum PassRejection {
  malformed,
  unsupportedVersion,
  unknownKey,
  badSignature,
  notYetValid,
  expired,
  wrongSociety,

  /// The proof is stale — almost always a forwarded screenshot rather than a clock
  /// problem, so the guard is told to ask for the live pass rather than to rescan.
  staleProof,

  /// A v2 pass shown without a proof at all. Must not degrade to a v1-style accept,
  /// which would make the whole mechanism opt-out for an attacker.
  missingProof,
}

class PassException implements Exception {
  const PassException(this.reason, this.message);

  final PassRejection reason;
  final String message;

  @override
  String toString() => message;
}

class PassPayload {
  const PassPayload({
    required this.passId,
    required this.societyId,
    required this.unitId,
    required this.validFrom,
    required this.validTo,
    required this.maxUses,
    required this.visitorHash,
    required this.keyVersion,
    this.holderPublicKey,
    this.screenshotProof = false,
  });

  final String passId;
  final String societyId;
  final String unitId;
  final DateTime validFrom;
  final DateTime validTo;
  final int maxUses;
  final String visitorHash;
  final int keyVersion;

  /// The resident device's public key, base64url raw. Null on v1 passes.
  final String? holderPublicKey;

  /// True only when a live holder proof was actually checked.
  ///
  /// A v1 pass verifies perfectly and is **not** screenshot-proof. Surfacing the
  /// difference lets the entry screen show it, and lets a society see how much of its
  /// estate is still on the weak format.
  final bool screenshotProof;
}

/// base64url without padding, matching Node's `base64url` encoding.
///
/// Dart's `base64Url` emits `=` padding and its decoder rejects input without it, so
/// both directions need adjusting. Getting this wrong produces a verifier that fails
/// only on payload lengths that are not a multiple of three — which is most of them,
/// intermittently, and looks like a signature problem rather than an encoding one.
Uint8List decodeB64Url(String input) {
  final normalised = input.replaceAll('-', '+').replaceAll('_', '/');
  final padded = normalised.padRight((normalised.length + 3) & ~3, '=');
  return base64.decode(padded);
}

String encodeB64Url(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

/// Verify a scanned QR against cached public keys.
///
/// [publicKeys] maps key version to a base64url raw 32-byte Ed25519 public key. Several
/// versions are held at once so a pass signed just before a weekly rotation still
/// verifies on a device that has not synced since.
///
/// [now] is injectable so the validity-window tests do not depend on the wall clock.
/// [expectedSocietyId], when given, rejects a pass minted for a different society —
/// which matters because guard handsets get moved between sites and a stolen one must
/// not work at the next gate.
Future<PassPayload> verifyPass(
  String qrValue,
  Map<int, String> publicKeys, {
  DateTime? now,
  String? expectedSocietyId,
  bool clockUntrusted = false,
}) async {
  final segments = qrValue.split('.');
  if (segments.length < 2 || segments[0].isEmpty || segments[1].isEmpty) {
    throw const PassException(
      PassRejection.malformed,
      'This QR code is not an entry pass.',
    );
  }

  final Uint8List body;
  final Uint8List signature;
  try {
    body = decodeB64Url(segments[0]);
    signature = decodeB64Url(segments[1]);
  } on FormatException {
    throw const PassException(
      PassRejection.malformed,
      'This QR code is not an entry pass.',
    );
  }

  final parts = utf8.decode(body, allowMalformed: true).split('|');
  final rolling = parts.isNotEmpty && parts[0] == passVersionRolling;

  if (parts.isEmpty ||
      (parts[0] != passVersion && !rolling) ||
      (!rolling && parts.length != 9) ||
      (rolling && parts.length != 10)) {
    if (parts.isNotEmpty && parts[0] != passVersion && !rolling) {
      throw const PassException(
        PassRejection.unsupportedVersion,
        'This pass was issued by a newer app. Update this device.',
      );
    }
    throw const PassException(
      PassRejection.malformed,
      'This QR code is not an entry pass.',
    );
  }

  final keyVersion = int.tryParse(parts[8]);
  final publicB64 = keyVersion == null ? null : publicKeys[keyVersion];
  if (publicB64 == null) {
    // The device has not synced recently enough to hold the signing key. Distinct from
    // a forged pass, and the guard's action is different: connect, then rescan.
    throw const PassException(
      PassRejection.unknownKey,
      'This pass cannot be checked offline. Connect this device and try again.',
    );
  }

  final algorithm = Ed25519();
  final publicKey = SimplePublicKey(
    decodeB64Url(publicB64),
    type: KeyPairType.ed25519,
  );

  final genuine = await algorithm.verify(
    body,
    signature: Signature(signature, publicKey: publicKey),
  );
  if (!genuine) {
    throw const PassException(
      PassRejection.badSignature,
      'This entry pass is not genuine.',
    );
  }

  // The society signed the holder's public key into the body above, so it is trusted
  // without a lookup — which is exactly what keeps this working with no network.
  final holderPublicKey = rolling ? parts[9] : null;
  var screenshotProof = false;

  if (rolling && !clockUntrusted) {
    if (segments.length < 4 || segments[2].isEmpty || segments[3].isEmpty) {
      throw const PassException(
        PassRejection.missingProof,
        'Ask the visitor to show the pass in their app, not a screenshot.',
      );
    }

    final presented = int.tryParse(segments[2]);
    if (presented == null) {
      throw const PassException(
        PassRejection.malformed,
        'This QR code is not an entry pass.',
      );
    }

    final expected = rollingCounter(now ?? DateTime.now().toUtc());
    if ((presented - expected).abs() > rollingToleranceSteps) {
      // The commonest cause by far is a forwarded screenshot, so the message says so.
      // A guard reading "expired" would just try rescanning the same picture.
      throw const PassException(
        PassRejection.staleProof,
        'This code has expired. Ask for the live pass in their app.',
      );
    }

    final proofOk = await algorithm.verify(
      utf8.encode('${parts[1]}|$presented'),
      signature: Signature(
        decodeB64Url(segments[3]),
        publicKey: SimplePublicKey(
          decodeB64Url(holderPublicKey!),
          type: KeyPairType.ed25519,
        ),
      ),
    );
    if (!proofOk) {
      throw const PassException(
        PassRejection.badSignature,
        'This entry pass is not genuine.',
      );
    }

    screenshotProof = true;
  }

  final payload = PassPayload(
    passId: parts[1],
    societyId: parts[2],
    unitId: parts[3],
    validFrom: DateTime.fromMillisecondsSinceEpoch(
      int.parse(parts[4]) * 1000,
      isUtc: true,
    ),
    validTo: DateTime.fromMillisecondsSinceEpoch(
      int.parse(parts[5]) * 1000,
      isUtc: true,
    ),
    maxUses: int.parse(parts[6]),
    visitorHash: parts[7],
    keyVersion: keyVersion!,
    holderPublicKey: holderPublicKey,
    screenshotProof: screenshotProof,
  );

  // Signature first, window second. A forged pass with a valid-looking window must fail
  // as a forgery, not as "expired" — the two get very different responses from a guard.
  if (expectedSocietyId != null && payload.societyId != expectedSocietyId) {
    throw const PassException(
      PassRejection.wrongSociety,
      'This pass was issued for a different society.',
    );
  }

  final at = (now ?? DateTime.now().toUtc()).toUtc();
  if (at.isBefore(payload.validFrom)) {
    throw const PassException(
      PassRejection.notYetValid,
      'This pass is not valid yet.',
    );
  }
  if (at.isAfter(payload.validTo)) {
    throw const PassException(PassRejection.expired, 'This pass has expired.');
  }

  return payload;
}
