/// Money display.
///
/// The point of these tests is not that formatting is pretty. It is that the app never
/// parses a rupee figure into a float — so the cases below deliberately include values
/// that a `double` round-trip would damage, and assert the string survives intact.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:watchmygate_resident/features/money.dart';

void main() {
  group('Indian grouping', () {
    test('groups last three then pairs', () {
      expect(formatRupees('1234567.50'), '₹12,34,567.50');
      expect(formatRupees('123456.00'), '₹1,23,456.00');
      expect(formatRupees('12345.00'), '₹12,345.00');
      expect(formatRupees('1234.00'), '₹1,234.00');
    });

    test('leaves short amounts alone', () {
      expect(formatRupees('999.00'), '₹999.00');
      expect(formatRupees('0.00'), '₹0.00');
    });

    test('handles a crore', () {
      expect(formatRupees('123456789.00'), '₹12,34,56,789.00');
    });

    test('is not Western grouping', () {
      // A resident reading ₹1,234,567 has to stop and count.
      expect(formatRupees('1234567.00'), isNot(contains('1,234,567')));
    });
  });

  group('no float ever touches an amount', () {
    test('preserves values a double round-trip would damage', () {
      // 0.1 + 0.2 territory. These pass through as digits, untouched.
      for (final raw in [
        '6497.499999999964',
        '0.145',
        '1234567890123.99',
        '99999999999999999.99',
      ]) {
        final formatted = formatRupees(raw, withSymbol: false, decimals: 0);
        final digitsIn = raw.split('.').first;
        final digitsOut = formatted.replaceAll(',', '');
        expect(digitsOut, digitsIn, reason: raw);
      }
    });

    test('does not round the paise it displays', () {
      // Truncates to the requested places rather than rounding, because rounding here
      // would make the app disagree with the invoice by a paisa.
      expect(formatRupees('10.999'), '₹10.99');
    });

    test('pads a short fraction rather than inventing digits', () {
      expect(formatRupees('10.5'), '₹10.50');
      expect(formatRupees('10'), '₹10.00');
    });
  });

  group('robustness', () {
    test('negative amounts keep their sign', () {
      expect(formatRupees('-1234.00'), '-₹1,234.00');
    });

    test('unparseable input is returned unchanged, never thrown', () {
      // A display helper must never be why a dues screen fails to render.
      for (final junk in ['', 'abc', '1,234', '₹500', '1.2.3']) {
        expect(() => formatRupees(junk), returnsNormally);
      }
      expect(formatRupees('abc'), 'abc');
    });
  });

  group('isOutstanding', () {
    test('true only for a positive non-zero amount', () {
      expect(isOutstanding('0.00'), isFalse);
      expect(isOutstanding('0'), isFalse);
      expect(isOutstanding('0.01'), isTrue);
      expect(isOutstanding('1500.00'), isTrue);
      expect(isOutstanding('-50.00'), isFalse);
    });

    test('works on a value too large for a double to hold exactly', () {
      expect(isOutstanding('99999999999999999999.01'), isTrue);
    });
  });
}
