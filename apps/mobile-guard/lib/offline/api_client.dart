/// HTTP transport for the outbox drain.
///
/// The only part of the guard app that touches the network, deliberately kept behind the
/// `SyncTransport` signature so the engine's logic is testable without one.
///
/// The classification here is what the engine acts on, so it is the security-relevant
/// part: mapping a 5xx to "rejected" would park a shift's worth of good events during a
/// server incident, and mapping a 422 to "retryable" would wedge the queue behind a row
/// that can never succeed.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'outbox.dart';
import 'sync_engine.dart';

class GateApiClient {
  GateApiClient({
    required this.baseUrl,
    required this.token,
    http.Client? client,
    this.timeout = const Duration(seconds: 20),
  }) : _client = client ?? http.Client();

  final String baseUrl;
  final String token;
  final Duration timeout;
  final http.Client _client;

  /// Upload a batch to `POST /v1/gate/sync`.
  Future<SyncResponse> sync(List<OutboxRow> batch) async {
    final body = jsonEncode({
      'events': batch.map((r) => {'id': r.id, ...r.payload}).toList(),
    });

    late http.Response res;
    try {
      res = await _client
          .post(
            Uri.parse('$baseUrl/v1/gate/sync'),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: body,
          )
          .timeout(timeout);
    } catch (e) {
      // No signal, DNS failure, timeout — the events are fine.
      throw TransientSyncFailure('$e');
    }

    if (res.statusCode == 401 || res.statusCode == 403) {
      throw AuthSyncFailure('session rejected (${res.statusCode})');
    }
    if (res.statusCode >= 500) {
      // The server is having a bad day. Never park good events for that.
      throw TransientSyncFailure('server error ${res.statusCode}');
    }
    if (res.statusCode != 200 && res.statusCode != 201) {
      // A 4xx on the whole batch means the request shape is wrong — a bug in this app,
      // not a bad event. Retrying is pointless but parking every row is worse, so it is
      // surfaced as transient and the attempt counter eventually parks them with a
      // readable reason.
      throw TransientSyncFailure('rejected batch (${res.statusCode}) ${res.body}');
    }

    final decoded = jsonDecode(res.body) as Map<String, dynamic>;
    final results = (decoded['results'] as List<dynamic>? ?? []);

    return SyncResponse(
      outcomes: {
        for (final r in results.cast<Map<String, dynamic>>())
          r['id'] as String: r['status'] as String,
      },
      maxDriftSeconds: (decoded['maxDriftSeconds'] as num? ?? 0).round(),
    );
  }

  void close() => _client.close();
}
