/// The approval countdown.
///
/// Pure arithmetic, but it drives what a resident is told about a request that is
/// escalating underneath them. Getting it wrong makes the app look broken at exactly the
/// moment a delivery agent is standing at the gate.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:watchmygate_resident/features/approvals.dart';

void main() {
  final requested = DateTime.utc(2026, 8, 15, 19, 0, 0);

  PendingApproval at(int secondsAgo) => PendingApproval(
        id: 'a',
        category: 'delivery',
        requestedAt: requested,
      );

  DateTime clock(int secondsLater) => requested.add(Duration(seconds: secondsLater));

  group('countdown to the next rung', () {
    test('immediately after the request, the 20s call is next', () {
      expect(at(0).secondsToNextRung(now: clock(0)), 20);
    });

    test('counts down within a rung', () {
      expect(at(0).secondsToNextRung(now: clock(15)), 5);
    });

    test('rolls to the next rung once one fires', () {
      expect(at(0).secondsToNextRung(now: clock(20)), 25); // 45 - 20
      expect(at(0).secondsToNextRung(now: clock(50)), 40); // 90 - 50
    });

    test('is null once the ladder is exhausted', () {
      // Nothing further will happen automatically. Showing a countdown here would be a
      // lie, and a resident who trusts it stops answering.
      expect(at(0).secondsToNextRung(now: clock(90)), isNull);
      expect(at(0).secondsToNextRung(now: clock(600)), isNull);
    });
  });

  group('what the resident is told has happened', () {
    test('rung count grows with the ladder', () {
      expect(at(0).rungsFired(now: clock(0)), 1); // push
      expect(at(0).rungsFired(now: clock(21)), 2); // + IVR
      expect(at(0).rungsFired(now: clock(46)), 3); // + standing rule
      expect(at(0).rungsFired(now: clock(91)), 4); // + committee
    });

    test('escalation is only true once the committee has been called', () {
      // The distinction matters: before this, the request is between the guard and the
      // flat. After it, someone else has been pulled in and the resident should know.
      expect(at(0).escalated(now: clock(89)), isFalse);
      expect(at(0).escalated(now: clock(90)), isTrue);
    });
  });

  group('a stale request', () {
    test('an old request reports the ladder finished rather than negative time', () {
      final old = PendingApproval(
        id: 'a',
        category: 'guest',
        requestedAt: DateTime.utc(2020),
      );
      expect(old.secondsToNextRung(now: DateTime.utc(2026)), isNull);
      expect(old.rungsFired(now: DateTime.utc(2026)), ladderSeconds.length);
    });

    test('a clock skewed backwards never produces a negative countdown', () {
      // Phone clocks are wrong. A negative countdown rendering as "-14s" is the kind of
      // detail that makes a resident distrust the whole screen.
      final future = PendingApproval(
        id: 'a',
        category: 'guest',
        requestedAt: DateTime.utc(2026, 8, 15, 19, 0, 30),
      );
      final n = future.secondsToNextRung(now: DateTime.utc(2026, 8, 15, 19, 0, 0));
      expect(n, isNotNull);
      expect(n, greaterThan(0));
    });
  });

  test('parses a payload with only the fields the server guarantees', () {
    final p = PendingApproval.fromJson({
      'id': 'x',
      'requestedAt': '2026-08-15T19:00:00.000Z',
    });
    expect(p.id, 'x');
    expect(p.category, 'guest');
    expect(p.visitorName, isNull);
  });
}
