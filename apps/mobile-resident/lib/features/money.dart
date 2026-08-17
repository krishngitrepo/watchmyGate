/// Displaying money.
///
/// **This file contains no arithmetic and never will.** Every amount arrives from the
/// server as a decimal string and is formatted as one. The total a resident sees and the
/// total filed for GST must not differ by a paisa, and the only way to guarantee that is
/// for one implementation to exist — the server's.
///
/// Parsing a rupee figure into a Dart `double` to format it would reintroduce exactly the
/// float error the whole money design avoids: 250 × ₹25.99 is 6497.499999999964 in
/// binary floating point, and a bill off by a paisa is a bill a treasurer stops trusting.
/// So the grouping below is done on the *digit string*.
///
/// Grouping is Indian, not Western: ₹12,34,567 — last three digits, then pairs. A
/// resident reading ₹1,234,567 has to stop and count, and a treasurer reading it in a
/// report will assume the software was built for somewhere else.
library;

/// Format a decimal string as Indian-grouped rupees.
///
/// Accepts what the API sends: an optionally signed decimal string such as `"1234567.50"`.
/// Anything unparseable is returned unchanged rather than throwing — a display helper
/// must never be the reason a dues screen fails to render.
String formatRupees(String amount, {bool withSymbol = true, int decimals = 2}) {
  final trimmed = amount.trim();
  if (trimmed.isEmpty) return trimmed;

  final match = RegExp(r'^(-?)(\d+)(?:\.(\d+))?$').firstMatch(trimmed);
  if (match == null) return amount;

  final sign = match.group(1)!;
  final whole = match.group(2)!;
  final fraction = match.group(3) ?? '';

  final grouped = _groupIndian(whole);

  final paise = decimals == 0
      ? ''
      : '.${fraction.padRight(decimals, '0').substring(0, decimals)}';

  return '$sign${withSymbol ? '₹' : ''}$grouped$paise';
}

/// Indian digit grouping, on the string. Last three, then pairs.
String _groupIndian(String digits) {
  if (digits.length <= 3) return digits;

  final lastThree = digits.substring(digits.length - 3);
  var rest = digits.substring(0, digits.length - 3);

  final parts = <String>[];
  while (rest.length > 2) {
    parts.insert(0, rest.substring(rest.length - 2));
    rest = rest.substring(0, rest.length - 2);
  }
  if (rest.isNotEmpty) parts.insert(0, rest);

  return '${parts.join(',')},$lastThree';
}

/// Is this amount owed? String comparison, no parsing.
///
/// A `double.parse(...) > 0` here would be the one place a float sneaks into the money
/// path, and it would be wrong for exactly the values that matter least visibly.
bool isOutstanding(String amount) {
  final t = amount.trim();
  if (t.startsWith('-')) return false;
  return RegExp(r'[1-9]').hasMatch(t);
}
