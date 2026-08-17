/// Shifts, and the purge that ends one.
///
/// This is the part of the guard app that exists for the residents rather than for the
/// guard. A handset is shared: the person holding it at 6am is not the person who held
/// it at 10pm, and nothing about a resident should survive that change of hands.
///
/// So a shift end wipes every cached name, phone number and photo. What it must **not**
/// touch is the outbox — those are entry records the society is entitled to, and a
/// device that has been offline all night may still be holding them. Purging them to be
/// tidy would delete the shift's work.
///
/// The split is the whole design: **PII is cache, gate events are records.** Cache is
/// disposable and gets wiped on every handover. Records are append-only and leave only
/// by being uploaded.
library;

import 'package:sqlite3/sqlite3.dart';

class ShiftStore {
  ShiftStore(this._db) {
    _migrate();
  }

  final Database _db;

  void _migrate() {
    _db.execute('''
      CREATE TABLE IF NOT EXISTS shift (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        guard_name  TEXT,
        started_at  TEXT,
        ended_at    TEXT
      );
    ''');

    /// Resident and visitor details, cached so the gate can show a name while offline.
    /// Everything in here is disposable by definition.
    _db.execute('''
      CREATE TABLE IF NOT EXISTS pii_cache (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        cached_at  TEXT NOT NULL
      );
    ''');

    /// Society signing keys. Several versions at once, so a pass signed just before a
    /// weekly rotation still verifies on a device that has not synced since.
    _db.execute('''
      CREATE TABLE IF NOT EXISTS signing_keys (
        version    INTEGER PRIMARY KEY,
        public_b64 TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    ''');
  }

  void startShift(String guardName, {DateTime? now}) {
    final at = (now ?? DateTime.now()).toUtc().toIso8601String();
    _db.execute(
      '''INSERT INTO shift (id, guard_name, started_at, ended_at) VALUES (1, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET guard_name = ?, started_at = ?, ended_at = NULL''',
      [guardName, at, guardName, at],
    );
  }

  ({String? guardName, DateTime? startedAt})? currentShift() {
    final rows = _db.select('SELECT * FROM shift WHERE id = 1 AND ended_at IS NULL');
    if (rows.isEmpty) return null;
    final r = rows.first;
    return (
      guardName: r['guard_name'] as String?,
      startedAt: r['started_at'] == null
          ? null
          : DateTime.parse(r['started_at'] as String),
    );
  }

  /// Cache a resident or visitor detail for offline display.
  void cachePii(String key, String value, {DateTime? now}) {
    _db.execute(
      '''INSERT INTO pii_cache (key, value, cached_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = ?, cached_at = ?''',
      [
        key,
        value,
        (now ?? DateTime.now()).toUtc().toIso8601String(),
        value,
        (now ?? DateTime.now()).toUtc().toIso8601String(),
      ],
    );
  }

  String? pii(String key) {
    final rows = _db.select('SELECT value FROM pii_cache WHERE key = ?', [key]);
    return rows.isEmpty ? null : rows.first['value'] as String?;
  }

  int piiCount() =>
      _db.select('SELECT count(*) AS n FROM pii_cache').first['n'] as int;

  void cacheSigningKey(int version, String publicB64, {DateTime? now}) {
    _db.execute(
      '''INSERT INTO signing_keys (version, public_b64, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(version) DO UPDATE SET public_b64 = ?, fetched_at = ?''',
      [
        version,
        publicB64,
        (now ?? DateTime.now()).toUtc().toIso8601String(),
        publicB64,
        (now ?? DateTime.now()).toUtc().toIso8601String(),
      ],
    );
  }

  /// Every cached key, for the offline verifier.
  Map<int, String> signingKeys() {
    final rows = _db.select('SELECT version, public_b64 FROM signing_keys');
    return {
      for (final r in rows) r['version'] as int: r['public_b64'] as String,
    };
  }

  /// End the shift and purge resident data.
  ///
  /// Returns how many cached items were destroyed, so the handover screen can state it
  /// rather than claim it — a guard signing off should see the number.
  ///
  /// Signing keys survive deliberately. They are public keys, not PII, and discarding
  /// them would leave the next shift unable to verify a single pass until the device
  /// next has signal — which defeats the entire offline guarantee at exactly the moment
  /// it matters, the 6am handover.
  int endShift({DateTime? now}) {
    final purged = piiCount();
    _db.execute('DELETE FROM pii_cache');
    _db.execute(
      'UPDATE shift SET ended_at = ? WHERE id = 1',
      [(now ?? DateTime.now()).toUtc().toIso8601String()],
    );
    return purged;
  }
}
