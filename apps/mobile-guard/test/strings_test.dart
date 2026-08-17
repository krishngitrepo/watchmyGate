/// Translation coverage.
///
/// A missing string in a guard app is not cosmetic. The verdict lines — expired, not
/// genuine, wrong society — are what a guard acts on at 3am with nobody to ask, and an
/// English fallback in the middle of a Kannada screen is exactly when someone waves
/// through a pass they should have refused.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:watchmygate_guard/l10n/strings.dart';

void main() {
  test('every language covers every key', () {
    final expected = stringKeys.toSet();
    final missing = <String, List<String>>{};

    for (final language in AppLanguage.values) {
      final have = allTranslations[language.code]?.keys.toSet() ?? <String>{};
      final gap = expected.difference(have).toList()..sort();
      if (gap.isNotEmpty) missing[language.code] = gap;
    }

    expect(missing, isEmpty, reason: 'untranslated keys: $missing');
  });

  test('all eight languages are present', () {
    expect(AppLanguage.values.length, 8);
    for (final language in AppLanguage.values) {
      expect(
        allTranslations.containsKey(language.code),
        isTrue,
        reason: '${language.code} has no strings at all',
      );
    }
  });

  test('each language names itself in its own script', () {
    // A guard looking for their language should not have to read English to find it.
    for (final language in AppLanguage.values) {
      expect(language.label, isNotEmpty);
    }
    expect(AppLanguage.kannada.label, 'ಕನ್ನಡ');
    expect(AppLanguage.hindi.label, 'हिन्दी');
  });

  test('nothing is left as an untranslated copy of the English', () {
    // A placeholder that was never translated reads as finished work and ships.
    final english = allTranslations['en']!;
    for (final language in AppLanguage.values) {
      if (language == AppLanguage.english) continue;
      final theirs = allTranslations[language.code]!;

      for (final key in english.keys) {
        expect(
          theirs[key],
          isNot(english[key]),
          reason: '${language.code}.$key is still the English string',
        );
      }
    }
  });

  test('the verdicts a guard acts on are all distinct within a language', () {
    // "Expired" means call the flat; "not genuine" means call the committee. If a
    // translation collapses them into the same words, the distinction the verifier works
    // so hard to make is destroyed at the last step.
    const verdicts = ['valid', 'expired', 'notYetValid', 'notGenuine', 'wrongSociety'];

    for (final language in AppLanguage.values) {
      final s = Strings(language);
      final rendered = verdicts.map(s.call).toList();
      expect(
        rendered.toSet().length,
        verdicts.length,
        reason: '${language.code} renders two different verdicts identically: $rendered',
      );
    }
  });

  test('an unknown key returns the key rather than throwing', () {
    expect(const Strings(AppLanguage.tamil)('nope'), 'nope');
  });

  test('an unknown language code falls back to English', () {
    expect(AppLanguage.fromCode('xx'), AppLanguage.english);
    expect(AppLanguage.fromCode('kn'), AppLanguage.kannada);
  });
}
