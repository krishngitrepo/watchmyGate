/// Shift handover, and what the purge must and must not destroy.
///
/// The distinction these tests protect is the one the whole handover rests on: **PII is
/// cache, gate events are records.** Getting it backwards in either direction is a real
/// failure — purge too much and you delete a shift's unsynced work, purge too little and
/// a resident's number stays on a shared handset after the guard who saw it went home.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:watchmygate_guard/data/shift.dart';
import 'package:watchmygate_guard/offline/outbox.dart';
import 'package:watchmygate_guard/offline/uuid_v7.dart';

void main() {
  late Database db;
  late ShiftStore shift;
  late Outbox outbox;

  setUp(() {
    resetUuidV7Counter();
    db = sqlite3.openInMemory();
    shift = ShiftStore(db);
    outbox = Outbox(db);
  });

  tearDown(() => db.close());

  group('a shift', () {
    test('starts and is readable', () {
      shift.startShift('Suresh Kumar');
      expect(shift.currentShift()?.guardName, 'Suresh Kumar');
    });

    test('ending it closes the shift', () {
      shift.startShift('Suresh Kumar');
      shift.endShift();
      expect(shift.currentShift(), isNull);
    });

    test('a new guard replaces the old one rather than stacking', () {
      shift.startShift('Suresh Kumar');
      shift.startShift('Anita Rao');
      expect(shift.currentShift()?.guardName, 'Anita Rao');
    });
  });

  group('the purge', () {
    test('destroys every cached resident detail', () {
      shift.startShift('Suresh Kumar');
      shift.cachePii('unit:A-101:name', 'Priya Menon');
      shift.cachePii('unit:A-101:phone', '+919900000002');
      shift.cachePii('visitor:xyz:name', 'Ramesh');

      expect(shift.piiCount(), 3);
      final purged = shift.endShift();

      expect(purged, 3, reason: 'the handover screen states this number');
      expect(shift.piiCount(), 0);
      expect(shift.pii('unit:A-101:phone'), isNull);
    });

    test('does not touch the outbox — those are records, not cache', () {
      // A device offline all night is still holding the night's entries. Purging them
      // to be tidy would delete the shift's work and leave the society with a hole in
      // its gate log.
      shift.startShift('Suresh Kumar');
      outbox.add('gate_entry', {'visitorName': 'Ramesh'});
      outbox.add('gate_entry', {'visitorName': 'Lakshmi'});
      shift.cachePii('unit:A-101:name', 'Priya Menon');

      shift.endShift();

      expect(outbox.pending(), hasLength(2));
      expect(shift.piiCount(), 0);
    });

    test('keeps signing keys, or the next shift cannot verify anything', () {
      // Public keys are not PII. Discarding them would leave the incoming guard unable
      // to check a single pass until the device next has signal — defeating the offline
      // guarantee at exactly the moment it matters, the 6am handover.
      shift.startShift('Suresh Kumar');
      shift.cacheSigningKey(3, 'AAAA');
      shift.cacheSigningKey(4, 'BBBB');
      shift.cachePii('unit:A-101:name', 'Priya Menon');

      shift.endShift();

      expect(shift.signingKeys(), {3: 'AAAA', 4: 'BBBB'});
      expect(shift.piiCount(), 0);
    });
  });

  group('signing keys', () {
    test('several versions are held at once', () {
      // A pass signed just before a weekly rotation must still verify on a device that
      // has not synced since.
      shift.cacheSigningKey(3, 'AAAA');
      shift.cacheSigningKey(4, 'BBBB');
      shift.cacheSigningKey(5, 'CCCC');
      expect(shift.signingKeys().length, 3);
    });

    test('re-fetching a version replaces it rather than duplicating', () {
      shift.cacheSigningKey(3, 'AAAA');
      shift.cacheSigningKey(3, 'ZZZZ');
      expect(shift.signingKeys(), {3: 'ZZZZ'});
    });
  });
}
