/// UUIDv7 — the idempotency key for every gate event.
///
/// The guard's handset generates the primary key, not the server. `gate_events.id` has
/// no database default for exactly this reason: the device decides the identity of an
/// event at the moment it happens, so replaying the same event — after a dropped
/// connection, a retry, or an app restart mid-upload — collides on the primary key and
/// the server's `onConflictDoNothing` makes it a no-op. Idempotency falls out of the
/// data model instead of needing a dedup table.
///
/// v7 rather than v4 because the first 48 bits are a millisecond timestamp. That makes
/// ids sort chronologically, so the outbox drains in the order events actually happened
/// and the server's index stays dense rather than fragmenting on random inserts — which
/// matters at 2M events a day.
///
/// Layout (RFC 9562):
///
///     0                   1                   2                   3
///     |unix_ts_ms (48 bits)          |ver|rand_a |var|   rand_b (62 bits)  |
library;

import 'dart:math';
import 'dart:typed_data';

/// Monotonic guard.
///
/// Two events inside the same millisecond would otherwise get ids that sort
/// unpredictably against each other. A guard scanning a family through the gate does
/// exactly that, and an out-of-order outbox makes the entry log read wrongly. Within a
/// millisecond the counter increments instead.
int _lastMs = 0;
int _counter = 0;

final Random _rng = Random.secure();

/// Generate a UUIDv7 as a canonical 36-character string.
///
/// [now] is injectable so tests can pin the clock; production always uses wall time.
String uuidV7({DateTime? now}) {
  final ms = (now ?? DateTime.now()).millisecondsSinceEpoch;

  if (ms == _lastMs) {
    _counter++;
  } else {
    _lastMs = ms;
    _counter = 0;
  }

  final bytes = Uint8List(16);

  // 48-bit big-endian millisecond timestamp.
  bytes[0] = (ms >> 40) & 0xff;
  bytes[1] = (ms >> 32) & 0xff;
  bytes[2] = (ms >> 24) & 0xff;
  bytes[3] = (ms >> 16) & 0xff;
  bytes[4] = (ms >> 8) & 0xff;
  bytes[5] = ms & 0xff;

  // 12 bits of rand_a, carrying the intra-millisecond counter so same-millisecond ids
  // still sort in creation order.
  final randA = (_counter & 0x0fff);
  bytes[6] = 0x70 | ((randA >> 8) & 0x0f); // version 7 in the high nibble
  bytes[7] = randA & 0xff;

  // 62 bits of randomness, with the RFC 4122 variant bits.
  for (var i = 8; i < 16; i++) {
    bytes[i] = _rng.nextInt(256);
  }
  bytes[8] = 0x80 | (bytes[8] & 0x3f);

  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}

/// Recover the creation time embedded in a v7 id.
///
/// Useful for triage: an outbox row that will not drain can be dated without any server
/// round trip, which is the only diagnostic available on a handset with no signal.
DateTime timestampOf(String uuid) {
  final hex = uuid.replaceAll('-', '').substring(0, 12);
  return DateTime.fromMillisecondsSinceEpoch(int.parse(hex, radix: 16));
}

/// Reset the monotonic state. Test-only.
void resetUuidV7Counter() {
  _lastMs = 0;
  _counter = 0;
}
