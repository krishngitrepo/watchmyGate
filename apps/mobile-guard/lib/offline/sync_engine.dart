/// Draining the outbox.
///
/// Runs whenever there is signal and is otherwise invisible. Nothing a guard does ever
/// waits on this — the barrier opens on local verification and sync catches up later.
///
/// The classification below is the whole engine, and it is the part that decides whether
/// a gate keeps reporting or silently goes dark:
///
/// **Transport failure** (no signal, timeout, 5xx) — the event is fine, the network is
/// not. Stays pending, retried with exponential backoff. Retrying forever is correct
/// here: a device can be offline for a day and every one of those events still matters.
///
/// **Per-event rejection** (the server accepted the batch but refused this row) — the
/// event will never succeed, so it is parked. Retrying it would block every later event
/// behind it and the gate would stop reporting entirely, which is the failure mode that
/// makes offline gate apps untrustworthy.
///
/// **Duplicate** — already on the server, from a previous attempt that succeeded but
/// whose response was lost. Treated exactly like acceptance. This is the case the
/// UUIDv7 primary key exists for.
///
/// **Auth failure** (401/403) — stops the drain without parking anything. The events are
/// good; the session is not. Parking them would discard a shift's work because a token
/// expired.
///
/// `prefer_initializing_formals` is disabled here: it would have the constructor take
/// `this._outbox`, putting underscore-prefixed names in a public signature. The private
/// fields and the public parameters are named differently on purpose.
// ignore_for_file: prefer_initializing_formals
library;

import 'dart:async';
import 'dart:math';

import 'outbox.dart';

/// Outcome of one upload attempt, as the transport reports it.
class SyncResponse {
  const SyncResponse({required this.outcomes, this.maxDriftSeconds = 0});

  /// Event id → one of `accepted`, `duplicate`, `rejected`.
  final Map<String, String> outcomes;

  /// Worst clock drift the server saw. Guard handsets are shared, cheap, and their
  /// clocks are routinely hours out; surfacing this is how a supervisor learns which
  /// device needs fixing before its timestamps end up in a dispute.
  final int maxDriftSeconds;
}

/// A failure that is worth retrying — the event is fine, the connection is not.
class TransientSyncFailure implements Exception {
  const TransientSyncFailure(this.message);
  final String message;
  @override
  String toString() => message;
}

/// The session is bad. Stop, do not park anything.
class AuthSyncFailure implements Exception {
  const AuthSyncFailure(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Uploads a batch. Injected so the engine is testable without a network.
typedef SyncTransport = Future<SyncResponse> Function(List<OutboxRow> batch);

class SyncReport {
  const SyncReport({
    required this.sent,
    required this.duplicates,
    required this.parked,
    required this.remaining,
    required this.maxDriftSeconds,
    this.stoppedBecause,
  });

  final int sent;
  final int duplicates;
  final int parked;
  final int remaining;
  final int maxDriftSeconds;
  final String? stoppedBecause;

  bool get drained => remaining == 0 && stoppedBecause == null;
}

class SyncEngine {
  SyncEngine({
    required Outbox outbox,
    required SyncTransport transport,
    this.batchSize = 50,
    this.maxAttempts = 8,
    Duration baseDelay = const Duration(milliseconds: 500),
    Future<void> Function(Duration)? sleep,
  })  : _outbox = outbox,
        _transport = transport,
        _baseDelay = baseDelay,
        _sleep = sleep ?? Future<void>.delayed;

  final Outbox _outbox;
  final SyncTransport _transport;
  final int batchSize;

  /// After this many transport failures a row is parked.
  ///
  /// Not infinite: a row that has failed eight times across separate connections is
  /// almost certainly malformed in a way the server rejects at the transport layer, and
  /// keeping it at the head of the queue blocks everything behind it. Eight attempts with
  /// the backoff below spans several minutes of genuine outage, so a real network
  /// problem never reaches it.
  final int maxAttempts;

  final Duration _baseDelay;
  final Future<void> Function(Duration) _sleep;

  /// Exponential backoff, capped. Injectable clock so tests do not actually wait.
  Duration delayFor(int attempt) {
    final ms = _baseDelay.inMilliseconds * pow(2, min(attempt, 6));
    return Duration(milliseconds: min(ms.toInt(), 30000));
  }

  /// Drain until the queue is empty or something says stop.
  Future<SyncReport> drain() async {
    var sent = 0;
    var duplicates = 0;
    var parked = 0;
    var maxDrift = 0;
    String? stopped;

    while (true) {
      final batch = _outbox.pending(limit: batchSize);
      if (batch.isEmpty) break;

      for (final row in batch) {
        _outbox.markSending(row.id);
      }

      SyncResponse response;
      try {
        response = await _transport(batch);
      } on AuthSyncFailure catch (e) {
        // The events are good; the session is not. Put them back and stop — parking
        // them would throw away a shift's work because a token expired.
        for (final row in batch) {
          _outbox.markRetryable(row.id, e.message);
        }
        stopped = 'auth: ${e.message}';
        break;
      } on TransientSyncFailure catch (e) {
        for (final row in batch) {
          if (row.attempts + 1 >= maxAttempts) {
            _outbox.park(row.id, 'gave up after ${row.attempts + 1}: ${e.message}');
            parked++;
          } else {
            _outbox.markRetryable(row.id, e.message);
          }
        }
        stopped = 'offline: ${e.message}';
        break;
      }

      maxDrift = max(maxDrift, response.maxDriftSeconds);

      for (final row in batch) {
        final outcome = response.outcomes[row.id];
        switch (outcome) {
          case 'accepted':
            _outbox.markSent(row.id);
            sent++;
          case 'duplicate':
            // Already there from an attempt whose response was lost. Exactly why the
            // handset generates the primary key.
            _outbox.markSent(row.id);
            duplicates++;
          case 'rejected':
            _outbox.park(row.id, 'server rejected the event');
            parked++;
          default:
            // The server said nothing about this row. Treat as transient rather than
            // assuming success — silently marking it sent would lose the event.
            _outbox.markRetryable(row.id, 'no outcome returned');
        }
      }

      // A batch where nothing moved would spin forever.
      final stillPending = _outbox.pending(limit: batchSize);
      if (stillPending.length == batch.length &&
          stillPending.first.id == batch.first.id) {
        stopped = 'no progress';
        break;
      }
    }

    return SyncReport(
      sent: sent,
      duplicates: duplicates,
      parked: parked,
      remaining: _outbox.pending(limit: 1000).length,
      maxDriftSeconds: maxDrift,
      stoppedBecause: stopped,
    );
  }

  /// Drain, retrying transport failures with backoff.
  ///
  /// Stops on auth failure — no amount of waiting fixes an expired session, and the
  /// guard needs to be told to sign in rather than watching a spinner.
  Future<SyncReport> drainWithRetry({int maxRounds = 5}) async {
    SyncReport report = await drain();
    var round = 0;

    while (!report.drained &&
        report.stoppedBecause != null &&
        !report.stoppedBecause!.startsWith('auth') &&
        round < maxRounds) {
      await _sleep(delayFor(round));
      round++;
      report = await drain();
    }
    return report;
  }
}
