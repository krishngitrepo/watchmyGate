/// Turning a verification result into what the guard sees.
///
/// Kept separate from the widget so it can be tested without a camera, a device or a
/// render tree — this is the logic a guard's decision actually rests on.
///
/// The design rule is one line: **the screen must be readable at arm's length, in
/// sunlight, by someone who is not reading the words.** A guard glances at a phone held
/// in one hand while a queue builds behind a car. Colour and a single large word carry
/// the decision; the explanation is for the case where they need it.
///
/// So there are three outcomes, not seven:
///
/// - **green — let them in**
/// - **amber — do not let them in, but nothing is wrong** (early, expired, unsynced key)
/// - **red — refuse and tell someone** (forged, or issued for another society)
///
/// Collapsing amber and red would be the mistake. A visitor a day early is not a
/// security event, and if the app treats them the same, guards learn to ignore both.
library;

import 'package:flutter/material.dart';

import '../l10n/strings.dart';
import '../offline/pass_verifier.dart';

enum VerdictTone { allow, refuse, alarm }

class Verdict {
  const Verdict({
    required this.tone,
    required this.headlineKey,
    this.payload,
  });

  final VerdictTone tone;
  final String headlineKey;
  final PassPayload? payload;

  String headline(Strings s) => s(headlineKey);

  bool get canAdmit => tone == VerdictTone.allow;

  Color get colour => switch (tone) {
        VerdictTone.allow => const Color(0xFF1B7A3E),
        VerdictTone.refuse => const Color(0xFFB4690E),
        VerdictTone.alarm => const Color(0xFFB3261E),
      };

  /// Whether the committee should be told. Only true for the two cases that indicate
  /// someone is trying it on, never for an honest mistake.
  bool get shouldEscalate => tone == VerdictTone.alarm;
}

/// Map a verification outcome to a verdict.
Verdict verdictFor(Object? result) {
  if (result is PassPayload) {
    return Verdict(
      tone: VerdictTone.allow,
      headlineKey: 'valid',
      payload: result,
    );
  }

  if (result is PassException) {
    return switch (result.reason) {
      // Honest mistakes. The visitor is real, the timing or the sync is not.
      PassRejection.expired =>
        const Verdict(tone: VerdictTone.refuse, headlineKey: 'expired'),
      PassRejection.notYetValid =>
        const Verdict(tone: VerdictTone.refuse, headlineKey: 'notYetValid'),
      PassRejection.unknownKey =>
        const Verdict(tone: VerdictTone.refuse, headlineKey: 'unknownKey'),
      PassRejection.malformed =>
        const Verdict(tone: VerdictTone.refuse, headlineKey: 'malformed'),
      PassRejection.unsupportedVersion =>
        const Verdict(tone: VerdictTone.refuse, headlineKey: 'malformed'),

      // A forwarded screenshot. Deliberately **refuse, not alarm**: people screenshot
      // their own passes constantly and hosts forward them to their own drivers, so
      // treating every one as an intrusion attempt would flood the committee with false
      // alarms and teach guards to ignore the real ones. The guard just asks for the
      // live pass.
      PassRejection.staleProof =>
        const Verdict(tone: VerdictTone.refuse, headlineKey: 'showLivePass'),
      PassRejection.missingProof =>
        const Verdict(tone: VerdictTone.refuse, headlineKey: 'showLivePass'),

      // Someone is trying it on.
      PassRejection.badSignature =>
        const Verdict(tone: VerdictTone.alarm, headlineKey: 'notGenuine'),
      PassRejection.wrongSociety =>
        const Verdict(tone: VerdictTone.alarm, headlineKey: 'wrongSociety'),
    };
  }

  // Anything unrecognised is refused, never admitted. Failing open at a gate is the one
  // failure mode with no acceptable version.
  return const Verdict(tone: VerdictTone.alarm, headlineKey: 'notGenuine');
}
