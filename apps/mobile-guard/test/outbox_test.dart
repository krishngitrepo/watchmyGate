/// The outbox, and the ordering guarantee it rests on.
///
/// These tests encode the failure modes that make offline gate apps untrustworthy: a
/// queue wedged behind one rejected row, events that upload out of order so the
/// "currently inside" list is wrong, and history a device quietly rewrites.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:watchmygate_guard/offline/outbox.dart';
import 'package:watchmygate_guard/offline/uuid_v7.dart';

void main() {
  late Outbox outbox;

  setUp(() {
    resetUuidV7Counter();
    outbox = Outbox.inMemory();
  });

  tearDown(() => outbox.dispose());

  group('queueing', () {
    test('an event survives being written and read back', () {
      final id = outbox.add('gate_entry', {
        'visitorName': 'Ramesh',
        'unitId': 'A-101',
      });

      final pending = outbox.pending();
      expect(pending, hasLength(1));
      expect(pending.first.id, id);
      expect(pending.first.payload['visitorName'], 'Ramesh');
      expect(pending.first.state, OutboxState.pending);
    });

    test('the id is a UUIDv7 carrying its creation time', () {
      final at = DateTime.utc(2026, 8, 15, 7, 30);
      final id = outbox.add('gate_entry', {}, now: at);

      expect(id, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-')));
      expect(
        timestampOf(id).millisecondsSinceEpoch,
        at.millisecondsSinceEpoch,
      );
    });
  });

  group('ordering', () {
    test('drains in the order events happened, not insertion order by chance', () {
      // A guard signing a family through the gate creates several events inside one
      // millisecond. If those sort unpredictably, entry and exit can arrive reversed and
      // the "currently inside" list is wrong.
      final at = DateTime.utc(2026, 8, 15, 7, 30);
      final ids = List.generate(
        20,
        (i) => outbox.add('gate_entry', {'seq': i}, now: at),
      );

      final drained = outbox.pending(limit: 100).map((r) => r.id).toList();
      expect(drained, ids, reason: 'same-millisecond ids must stay in creation order');

      final seqs =
          outbox.pending(limit: 100).map((r) => r.payload['seq']).toList();
      expect(seqs, List.generate(20, (i) => i));
    });

    test('ids from later milliseconds sort after earlier ones', () {
      final a = outbox.add('x', {}, now: DateTime.utc(2026, 8, 15, 7, 30));
      final b = outbox.add('x', {}, now: DateTime.utc(2026, 8, 15, 7, 31));
      expect(a.compareTo(b), lessThan(0));
    });
  });

  group('one bad row must never wedge the queue', () {
    test('a parked row stops being offered and the rest still drain', () {
      final bad = outbox.add('gate_entry', {'unitId': 'nonsense'});
      final good1 = outbox.add('gate_entry', {'unitId': 'A-101'});
      final good2 = outbox.add('gate_entry', {'unitId': 'A-102'});

      outbox.park(bad, '422 unknown unit');

      final ids = outbox.pending().map((r) => r.id).toList();
      expect(ids, [good1, good2]);
      expect(ids, isNot(contains(bad)));
    });

    test('a retryable failure keeps the row in the queue', () {
      final id = outbox.add('gate_entry', {});
      outbox.markSending(id);
      outbox.markRetryable(id, 'connection reset');

      final row = outbox.pending().single;
      expect(row.state, OutboxState.pending);
      expect(row.attempts, 1);
      expect(row.lastError, 'connection reset');
    });

    test('attempts accumulate across retries so a stuck row is visible', () {
      final id = outbox.add('gate_entry', {});
      for (var i = 0; i < 3; i++) {
        outbox.markSending(id);
        outbox.markRetryable(id, 'timeout');
      }
      expect(outbox.pending().single.attempts, 3);
    });
  });

  group('append-only', () {
    test('the database refuses a delete, not merely the code', () {
      // The same reasoning as the server's ledger and attendance tables: a control that
      // holds only while the calling code is correct is not a control.
      final id = outbox.add('gate_entry', {});
      expect(
        () => outbox.rawDeleteForTest(id),
        throwsA(anything),
      );
      expect(outbox.countByState(OutboxState.pending), 1);
    });

    test('a sent row is retained rather than removed', () {
      final id = outbox.add('gate_entry', {});
      outbox.markSending(id);
      outbox.markSent(id);

      expect(outbox.pending(), isEmpty);
      expect(outbox.countByState(OutboxState.sent), 1);
    });
  });

  group('supervisor view', () {
    test('parked events stay visible with their reason', () {
      final id = outbox.add('gate_entry', {'unitId': 'gone'});
      outbox.park(id, '404 unit no longer exists');

      final parked = outbox.parked();
      expect(parked, hasLength(1));
      expect(parked.single.lastError, '404 unit no longer exists');
      // Silently dropping these is how a gate log develops holes nobody notices.
      expect(parked.single.payload['unitId'], 'gone');
    });
  });
}
