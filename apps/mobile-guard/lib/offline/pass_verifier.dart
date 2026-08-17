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
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

/// Frozen. Any change to the canonical layout must bump this.
const String passVersion = 'v1';

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
  });

  final String passId;
  final String societyId;
  final String unitId;
  final DateTime validFrom;
  final DateTime validTo;
  final int maxUses;
  final String visitorHash;
  final int keyVersion;
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
}) async {
  final dot = qrValue.indexOf('.');
  if (dot <= 0 || dot == qrValue.length - 1) {
    throw const PassException(
      PassRejection.malformed,
      'This QR code is not an entry pass.',
    );
  }

  final Uint8List body;
  final Uint8List signature;
  try {
    body = decodeB64Url(qrValue.substring(0, dot));
    signature = decodeB64Url(qrValue.substring(dot + 1));
  } on FormatException {
    throw const PassException(
      PassRejection.malformed,
      'This QR code is not an entry pass.',
    );
  }

  final parts = utf8.decode(body, allowMalformed: true).split('|');
  if (parts.length != 9) {
    throw const PassException(
      PassRejection.malformed,
      'This QR code is not an entry pass.',
    );
  }
  if (parts[0] != passVersion) {
    throw const PassException(
      PassRejection.unsupportedVersion,
      'This pass was issued by a newer app. Update this device.',
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
