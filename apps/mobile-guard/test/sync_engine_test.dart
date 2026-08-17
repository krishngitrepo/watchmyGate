/// The sync engine's classification rules.
///
/// Each test here is a way real gate apps go dark: a queue wedged behind one rejected
/// row, a shift's work discarded because a token expired, an event silently marked sent
/// when the server never confirmed it.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:watchmygate_guard/offline/outbox.dart';
import 'package:watchmygate_guard/offline/sync_engine.dart';
import 'package:watchmygate_guard/offline/uuid_v7.dart';

void main() {
  late Outbox outbox;

  setUp(() {
    resetUuidV7Counter();
    outbox = Outbox.inMemory();
  });

  tearDown(() => outbox.dispose());

  /// A transport that answers with a fixed outcome for every row.
  SyncTransport allOf(String outcome, {int drift = 0}) {
    return (batch) async => SyncResponse(
          outcomes: {for (final r in batch) r.id: outcome},
          maxDriftSeconds: drift,
        );
  }

  group('the happy path', () {
    test('drains everything and leaves nothing pending', () async {
      for (var i = 0; i < 5; i++) {
        outbox.add('gate_entry', {'seq': i});
      }

      final report = await SyncEngine(
        outbox: outbox,
        transport: allOf('accepted'),
      ).drain();

      expect(report.sent, 5);
      expect(report.remaining, 0);
      expect(report.drained, isTrue);
      expect(outbox.countByState(OutboxState.sent), 5);
    });

    test('a duplicate counts as success, not as a failure', () async {
      // The upload succeeded but the response was lost, so the app retried. This is the
      // case the handset-generated UUIDv7 primary key exists for, and treating it as an
      // error would strand a perfectly good event forever.
      outbox.add('gate_entry', {});

      final report = await SyncEngine(
        outbox: outbox,
        transport: allOf('duplicate'),
      ).drain();

      expect(report.duplicates, 1);
      expect(report.remaining, 0);
      expect(outbox.countByState(OutboxState.parked), 0);
    });

    test('surfaces the worst clock drift the server saw', () async {
      outbox.add('gate_entry', {});
      final report = await SyncEngine(
        outbox: outbox,
        transport: allOf('accepted', drift: 4200),
      ).drain();

      // Guard handsets are shared and cheap and their clocks are routinely hours out.
      // A supervisor needs to know which device to fix before its timestamps land in a
      // dispute.
      expect(report.maxDriftSeconds, 4200);
    });
  });

  group('one rejected row must never wedge the queue', () {
    test('the rejected row parks and everything after it still uploads', () async {
      final bad = outbox.add('gate_entry', {'unitId': 'nonsense'});
      outbox.add('gate_entry', {'unitId': 'A-101'});
      outbox.add('gate_entry', {'unitId': 'A-102'});

      final engine = SyncEngine(
        outbox: outbox,
        transport: (batch) async => SyncResponse(
          outcomes: {
            for (final r in batch) r.id: r.id == bad ? 'rejected' : 'accepted',
          },
        ),
      );

      final report = await engine.drain();

      expect(report.parked, 1);
      expect(report.sent, 2);
      expect(report.remaining, 0, reason: 'the queue must not be blocked');
      expect(outbox.parked().single.id, bad);
    });
  });

  group('transport failures', () {
    test('being offline leaves everything pending, nothing parked', () async {
      for (var i = 0; i < 3; i++) {
        outbox.add('gate_entry', {'seq': i});
      }

      final report = await SyncEngine(
        outbox: outbox,
        transport: (_) async => throw const TransientSyncFailure('no signal'),
      ).drain();

      // A device can be offline for a day and every one of those events still matters.
      expect(report.parked, 0);
      expect(report.remaining, 3);
      expect(report.stoppedBecause, contains('offline'));
    });

    test('retries with backoff and succeeds once the network returns', () async {
      outbox.add('gate_entry', {});
      var calls = 0;
      final slept = <Duration>[];

      final engine = SyncEngine(
        outbox: outbox,
        baseDelay: const Duration(milliseconds: 1),
        sleep: (d) async => slept.add(d),
        transport: (batch) async {
          calls++;
          if (calls < 3) throw const TransientSyncFailure('timeout');
          return SyncResponse(outcomes: {for (final r in batch) r.id: 'accepted'});
        },
      );

      final report = await engine.drainWithRetry();

      expect(report.sent, 1);
      expect(report.remaining, 0);
      expect(slept.length, 2, reason: 'one wait per failed round');
      expect(slept[1], greaterThan(slept[0]), reason: 'backoff must grow');
    });

    test('a row that keeps failing eventually parks rather than blocking forever', () async {
      outbox.add('gate_entry', {});

      final engine = SyncEngine(
        outbox: outbox,
        maxAttempts: 3,
        baseDelay: const Duration(milliseconds: 1),
        sleep: (_) async {},
        transport: (_) async => throw const TransientSyncFailure('always fails'),
      );

      await engine.drainWithRetry(maxRounds: 10);

      // Eight attempts with real backoff spans several minutes, so a genuine outage
      // never reaches this. A row that fails across that many separate connections is
      // malformed, and leaving it at the head of the queue blocks the whole gate.
      expect(outbox.countByState(OutboxState.parked), 1);
      expect(outbox.parked().single.lastError, contains('gave up'));
    });
  });

  group('authentication', () {
    test('an expired session stops the drain without discarding a shift', () async {
      for (var i = 0; i < 4; i++) {
        outbox.add('gate_entry', {'seq': i});
      }

      final report = await SyncEngine(
        outbox: outbox,
        transport: (_) async => throw const AuthSyncFailure('token expired'),
      ).drain();

      expect(report.parked, 0, reason: 'the events are good, the session is not');
      expect(report.remaining, 4);
      expect(report.stoppedBecause, startsWith('auth'));
    });

    test('does not retry an auth failure — waiting never fixes it', () async {
      outbox.add('gate_entry', {});
      var calls = 0;

      final engine = SyncEngine(
        outbox: outbox,
        baseDelay: const Duration(milliseconds: 1),
        sleep: (_) async {},
        transport: (_) async {
          calls++;
          throw const AuthSyncFailure('token expired');
        },
      );

      await engine.drainWithRetry(maxRounds: 5);
      expect(calls, 1, reason: 'the guard needs telling to sign in, not a spinner');
    });
  });

  group('a silent server', () {
    test('an event the server said nothing about is retried, never assumed sent', () async {
      outbox.add('gate_entry', {});

      final report = await SyncEngine(
        outbox: outbox,
        transport: (_) async => const SyncResponse(outcomes: {}),
      ).drain();

      // Marking it sent would lose the event with no trace at all.
      expect(report.sent, 0);
      expect(report.remaining, 1);
      expect(report.stoppedBecause, 'no progress');
    });
  });

  group('backoff', () {
    test('grows and then caps', () {
      final engine = SyncEngine(outbox: outbox, transport: allOf('accepted'));
      expect(engine.delayFor(0).inMilliseconds, 500);
      expect(engine.delayFor(1).inMilliseconds, 1000);
      expect(engine.delayFor(2).inMilliseconds, 2000);
      // Capped, so a long outage does not turn into a half-hour blind spot.
      expect(engine.delayFor(20).inMilliseconds, 30000);
    });
  });
}
