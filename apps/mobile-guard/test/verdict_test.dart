/// What the guard sees, and the one thing that must never happen.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:watchmygate_guard/l10n/strings.dart';
import 'package:watchmygate_guard/offline/pass_verifier.dart';
import 'package:watchmygate_guard/ui/verdict.dart';

void main() {
  test('a valid pass admits', () {
    final v = verdictFor(PassPayload(
      passId: 'p',
      societyId: 's',
      unitId: 'u',
      validFrom: DateTime.utc(2026),
      validTo: DateTime.utc(2027),
      maxUses: 1,
      visitorHash: 'h',
      keyVersion: 3,
    ));
    expect(v.tone, VerdictTone.allow);
    expect(v.canAdmit, isTrue);
    expect(v.shouldEscalate, isFalse);
  });

  group('nothing else admits', () {
    // Failing open at a gate is the one failure mode with no acceptable version.
    test('no rejection reason ever admits', () {
      for (final reason in PassRejection.values) {
        final v = verdictFor(PassException(reason, 'x'));
        expect(v.canAdmit, isFalse, reason: '$reason must not admit');
      }
    });

    test('an unrecognised result refuses rather than admitting', () {
      expect(verdictFor(null).canAdmit, isFalse);
      expect(verdictFor('surprise').canAdmit, isFalse);
      expect(verdictFor(42).canAdmit, isFalse);
    });
  });

  group('honest mistakes are not security events', () {
    // A visitor a day early is not someone to escalate. If the app treats them like a
    // forgery, guards learn to ignore both.
    test('early, expired and unsynced refuse without alarming', () {
      for (final reason in [
        PassRejection.expired,
        PassRejection.notYetValid,
        PassRejection.unknownKey,
        PassRejection.malformed,
        PassRejection.unsupportedVersion,
      ]) {
        final v = verdictFor(PassException(reason, 'x'));
        expect(v.tone, VerdictTone.refuse, reason: '$reason');
        expect(v.shouldEscalate, isFalse, reason: '$reason must not escalate');
      }
    });

    test('forgery and wrong-society do alarm', () {
      for (final reason in [
        PassRejection.badSignature,
        PassRejection.wrongSociety,
      ]) {
        final v = verdictFor(PassException(reason, 'x'));
        expect(v.tone, VerdictTone.alarm, reason: '$reason');
        expect(v.shouldEscalate, isTrue, reason: '$reason must escalate');
      }
    });
  });

  test('every verdict has a headline in every language', () {
    for (final language in AppLanguage.values) {
      final s = Strings(language);
      for (final reason in PassRejection.values) {
        final text = verdictFor(PassException(reason, 'x')).headline(s);
        expect(text, isNotEmpty);
        // Falling back to the raw key would put "notYetValid" on a guard's screen.
        expect(text, isNot(matches(RegExp(r'^[a-z][a-zA-Z]+$'))),
            reason: '${language.code}/$reason fell back to the key');
      }
    }
  });

  test('the three tones are visually distinct', () {
    final colours = {
      for (final t in VerdictTone.values)
        t: verdictFor(t == VerdictTone.allow
                ? PassPayload(
                    passId: 'p',
                    societyId: 's',
                    unitId: 'u',
                    validFrom: DateTime.utc(2026),
                    validTo: DateTime.utc(2027),
                    maxUses: 1,
                    visitorHash: 'h',
                    keyVersion: 3,
                  )
                : PassException(
                    t == VerdictTone.alarm
                        ? PassRejection.badSignature
                        : PassRejection.expired,
                    'x',
                  ))
            .colour
    };
    expect(colours.values.toSet().length, 3);
  });
}
