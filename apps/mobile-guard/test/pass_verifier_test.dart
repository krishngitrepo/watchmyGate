/// Cross-language proof that the Dart verifier agrees with the TypeScript signer.
///
/// This is the most important test in the guard app. Two implementations of one
/// signature format drift — a reordered field, a different base64 variant, milliseconds
/// where seconds were meant — and the failure lands at a gate at 7am, on a device with
/// no network, in front of a queue. Nothing else in this app catches that.
///
/// The vectors are produced by `scripts/gen-pass-vectors.mjs` running the real
/// TypeScript signer. Regenerate them whenever the pass format changes; if these fail
/// after such a change, the two implementations no longer agree.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:watchmygate_guard/offline/pass_verifier.dart';

void main() {
  final file = File('../../packages/money/pass-vectors.json');
  final vectors =
      jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  final publicKeys = (vectors['publicKeys'] as Map<String, dynamic>)
      .map((k, v) => MapEntry(int.parse(k), v as String));
  final cases = vectors['cases'] as List<dynamic>;

  group('vectors signed by the TypeScript implementation', () {
    for (final raw in cases) {
      final c = raw as Map<String, dynamic>;
      final name = c['name'] as String;
      final expected = c['expect'] as String;

      test('$name → $expected', () async {
        final at = DateTime.fromMillisecondsSinceEpoch(
          c['verifyAtEpochMs'] as int,
          isUtc: true,
        );

        if (expected == 'valid') {
          final payload = await verifyPass(
            c['qr'] as String,
            publicKeys,
            now: at,
          );
          final want = c['payload'] as Map<String, dynamic>;

          // Every field, not just "it verified". A verifier that checks the signature
          // but misparses unitId admits the right visitor to the wrong flat.
          expect(payload.passId, want['passId']);
          expect(payload.societyId, want['societyId']);
          expect(payload.unitId, want['unitId']);
          expect(payload.maxUses, want['maxUses']);
          expect(payload.visitorHash, want['visitorHash']);
          expect(payload.keyVersion, want['keyVersion']);
          expect(
            payload.validFrom.millisecondsSinceEpoch ~/ 1000,
            want['validFrom'],
          );
          expect(
            payload.validTo.millisecondsSinceEpoch ~/ 1000,
            want['validTo'],
          );

          // A v2 vector claims screenshot protection. Verifying the signature but
          // reporting the pass as unprotected would leave the guard app unable to tell
          // a live pass from a photograph — which is the entire point of v2.
          if (c.containsKey('screenshotProof')) {
            expect(payload.screenshotProof, c['screenshotProof']);
            expect(payload.holderPublicKey, isNotNull);
          }
          return;
        }

        await expectLater(
          verifyPass(c['qr'] as String, publicKeys, now: at),
          throwsA(
            isA<PassException>().having(
              (e) => e.reason.name,
              'reason',
              expected,
            ),
          ),
        );
      });
    }
  });

  group('rejections a guard has to tell apart', () {
    final good = cases.firstWhere(
      (c) => (c as Map<String, dynamic>)['expect'] == 'valid',
    ) as Map<String, dynamic>;
    final at = DateTime.fromMillisecondsSinceEpoch(
      good['verifyAtEpochMs'] as int,
      isUtc: true,
    );

    test('a pass for another society is refused even though it is genuine', () async {
      await expectLater(
        verifyPass(
          good['qr'] as String,
          publicKeys,
          now: at,
          expectedSocietyId: '00000000-0000-0000-0000-000000000000',
        ),
        throwsA(
          isA<PassException>().having(
            (e) => e.reason,
            'reason',
            PassRejection.wrongSociety,
          ),
        ),
      );
    });

    test('forgery reports as forgery, not as expiry', () async {
      // Ordering matters. If the window were checked first, a forged pass carrying an
      // old date would be reported as "expired" — and a guard would wave it through
      // tomorrow instead of flagging it.
      final tampered = cases.firstWhere(
        (c) => (c as Map<String, dynamic>)['expect'] == 'badSignature',
      ) as Map<String, dynamic>;

      await expectLater(
        verifyPass(
          tampered['qr'] as String,
          publicKeys,
          now: DateTime.utc(2099),
        ),
        throwsA(
          isA<PassException>().having(
            (e) => e.reason,
            'reason',
            PassRejection.badSignature,
          ),
        ),
      );
    });

    test('garbage QR is malformed, not a crash', () async {
      for (final junk in <String>[
        '',
        'not-a-pass',
        '.',
        'aaa.',
        '.bbb',
        'düsseldorf.çekoslovakya',
      ]) {
        await expectLater(
          verifyPass(junk, publicKeys, now: at),
          throwsA(isA<PassException>()),
          reason: 'input: "$junk"',
        );
      }
    });
  });

  group('base64url handling', () {
    test('decodes lengths that need 0, 1 and 2 padding characters', () {
      // Node emits unpadded base64url; Dart's decoder rejects unpadded input. Getting
      // this wrong fails only on some payload lengths, which reads as a signature bug.
      expect(decodeB64Url(encodeB64Url([1])), [1]);
      expect(decodeB64Url(encodeB64Url([1, 2])), [1, 2]);
      expect(decodeB64Url(encodeB64Url([1, 2, 3])), [1, 2, 3]);
      expect(decodeB64Url(encodeB64Url([1, 2, 3, 4])), [1, 2, 3, 4]);
    });

    test('handles the URL-safe alphabet', () {
      // 0xFB 0xFF produces '-' and '_' in base64url and '+' and '/' in standard base64.
      final bytes = [0xfb, 0xff, 0xbf];
      final encoded = encodeB64Url(bytes);
      expect(encoded.contains('+'), isFalse);
      expect(encoded.contains('/'), isFalse);
      expect(decodeB64Url(encoded), bytes);
    });
  });
}
