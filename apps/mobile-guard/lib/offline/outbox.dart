/// The append-only outbox.
///
/// Every gate event is written here first and uploaded later. The guard's workflow never
/// waits on the network — the barrier opens on local verification, and sync is a
/// background concern. That inversion is the whole design: at an Indian apartment gate,
/// no signal is the normal condition, not the exception.
///
/// Three properties this has to hold, each learned from how these systems fail:
///
/// **Append-only.** Rows are never edited or deleted, only marked sent. A guard app that
/// rewrites its own history cannot be reconciled against the server when the two
/// disagree, and disagreement is guaranteed on a device that has been offline for a day.
///
/// **One bad row must never wedge the queue.** A single event the server rejects with a
/// 4xx — a malformed unit id, a pass the committee revoked — would otherwise block every
/// later event behind it forever, and the gate silently stops reporting. Rejected rows
/// are parked, not retried.
///
/// **Ordered drain.** Ids are UUIDv7, so ordering by id is chronological. Entry and exit
/// for the same visitor arrive in the order they happened, which is what makes the
/// "currently inside" list correct.
library;

import 'dart:convert';

import 'package:sqlite3/sqlite3.dart';

import 'uuid_v7.dart';

/// Where a row sits in its life.
///
/// `parked` exists so a permanently rejected event stays visible rather than being
/// deleted. A guard's supervisor needs to see that four entries never uploaded; silently
/// dropping them is how a gate log develops holes nobody notices.
enum OutboxState { pending, sending, sent, parked }

class OutboxRow {
  const OutboxRow({
    required this.id,
    required this.kind,
    required this.payload,
    required this.state,
    required this.attempts,
    required this.createdAt,
    this.lastError,
  });

  final String id;
  final String kind;
  final Map<String, dynamic> payload;
  final OutboxState state;
  final int attempts;
  final DateTime createdAt;
  final String? lastError;
}

class Outbox {
  Outbox(this._db) {
    _migrate();
  }

  final Database _db;

  /// Open an in-memory outbox. Test-only; production passes an encrypted file handle.
  factory Outbox.inMemory() => Outbox(sqlite3.openInMemory());

  void _migrate() {
    _db.execute('''
      CREATE TABLE IF NOT EXISTS outbox (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        created_at  TEXT NOT NULL,
        sent_at     TEXT
      );
    ''');
    // Drains order by id, which is chronological because ids are UUIDv7.
    _db.execute(
      'CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox (state, id);',
    );

    /// Deletion is blocked in the database, not merely avoided in the code above.
    /// A control that only holds while the calling code is correct is not a control —
    /// the same reasoning as the server's ledger and attendance triggers.
    _db.execute('''
      CREATE TRIGGER IF NOT EXISTS trg_outbox_no_delete
      BEFORE DELETE ON outbox
      BEGIN
        SELECT RAISE(ABORT, 'The gate outbox is append-only.');
      END;
    ''');
  }

  /// Queue an event. Returns the id the server will dedup on.
  ///
  /// The id is generated here rather than by the server precisely so that a retry after
  /// an ambiguous failure carries the same key and cannot create a duplicate entry.
  String add(String kind, Map<String, dynamic> payload, {DateTime? now}) {
    final id = uuidV7(now: now);
    _db.execute(
      'INSERT INTO outbox (id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
      [
        id,
        kind,
        jsonEncode(payload),
        (now ?? DateTime.now()).toUtc().toIso8601String(),
      ],
    );
    return id;
  }

  /// The next batch to upload, oldest first.
  List<OutboxRow> pending({int limit = 50}) {
    final rows = _db.select(
      "SELECT * FROM outbox WHERE state IN ('pending','sending') ORDER BY id LIMIT ?",
      [limit],
    );
    return rows.map(_toRow).toList();
  }

  void markSending(String id) {
    _db.execute(
      "UPDATE outbox SET state = 'sending', attempts = attempts + 1 WHERE id = ?",
      [id],
    );
  }

  void markSent(String id, {DateTime? now}) {
    _db.execute(
      "UPDATE outbox SET state = 'sent', sent_at = ?, last_error = NULL WHERE id = ?",
      [(now ?? DateTime.now()).toUtc().toIso8601String(), id],
    );
  }

  /// A transient failure — network, 5xx. Stays pending and will be retried.
  void markRetryable(String id, String error) {
    _db.execute(
      "UPDATE outbox SET state = 'pending', last_error = ? WHERE id = ?",
      [error, id],
    );
  }

  /// A permanent failure — the server rejected the event itself.
  ///
  /// Parked rather than retried, so it cannot block the queue behind it, and parked
  /// rather than deleted, so the gap stays visible to a supervisor.
  void park(String id, String error) {
    _db.execute(
      "UPDATE outbox SET state = 'parked', last_error = ? WHERE id = ?",
      [error, id],
    );
  }

  int countByState(OutboxState state) {
    final r = _db.select(
      'SELECT count(*) AS n FROM outbox WHERE state = ?',
      [state.name],
    );
    return r.first['n'] as int;
  }

  /// What a supervisor sees: events that will never upload without intervention.
  List<OutboxRow> parked() {
    final rows = _db.select(
      "SELECT * FROM outbox WHERE state = 'parked' ORDER BY id",
    );
    return rows.map(_toRow).toList();
  }

  /// Attempt a raw delete. **Test-only.**
  ///
  /// Exists so the append-only trigger can be proven to fire rather than assumed. There
  /// is no production path that deletes an outbox row, which is precisely why the
  /// guarantee needs a test that tries.
  void rawDeleteForTest(String id) {
    _db.execute('DELETE FROM outbox WHERE id = ?', [id]);
  }

  OutboxRow _toRow(Row r) => OutboxRow(
        id: r['id'] as String,
        kind: r['kind'] as String,
        payload: jsonDecode(r['payload'] as String) as Map<String, dynamic>,
        state: OutboxState.values.byName(r['state'] as String),
        attempts: r['attempts'] as int,
        createdAt: DateTime.parse(r['created_at'] as String),
        lastError: r['last_error'] as String?,
      );

  void dispose() => _db.close();
}
