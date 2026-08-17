/// **The acceptance test for the guard app.**
///
/// Plan §11 test 2: put the device in airplane mode, scan a pre-issued pass, the entry
/// is admitted locally; restore connectivity and the event appears server-side exactly
/// once — replay the same payload three times and assert one row.
///
/// It runs against the live API rather than a mock, because the two things it proves
/// only hold end to end:
///
/// 1. **A pass verifies with the network genuinely unavailable.** The transport here is
///    one that throws on every call, which is a stronger condition than a slow network —
///    if any code path needed a request, this fails.
///
/// 2. **Replays produce exactly one row.** The handset generates the UUIDv7 primary key,
///    so a retry after an ambiguous failure collides and the server's
///    `onConflictDoNothing` makes it a no-op. Nothing else in the suite proves that the
///    two halves of that agreement actually line up.
///
/// Skipped automatically when the API is not running, so `flutter test` stays green
/// offline. Start it with `node --env-file=.env apps/api/dist/main.js` to include this.
library;

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:watchmygate_guard/offline/api_client.dart';
import 'package:watchmygate_guard/offline/outbox.dart';
import 'package:watchmygate_guard/offline/pass_verifier.dart';
import 'package:watchmygate_guard/offline/sync_engine.dart';

const baseUrl = 'http://localhost:8080';
const guardPhone = '+919900000003';

Future<bool> apiIsUp() async {
  try {
    final res = await http
        .get(Uri.parse('$baseUrl/healthz'))
        .timeout(const Duration(seconds: 2));
    return res.statusCode == 200;
  } catch (_) {
    return false;
  }
}

/// Sign in as the seeded guard and return a society-scoped token.
Future<String> guardToken() async {
  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body,
      [String? token]) async {
    final res = await http.post(
      Uri.parse('$baseUrl$path'),
      headers: {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      },
      body: jsonEncode(body),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  await post('/v1/auth/otp/request', {'phone': guardPhone});
  await Future<void>.delayed(const Duration(milliseconds: 500));

  final stub = jsonDecode(
    File('../../.otp-stub.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  final verified =
      await post('/v1/auth/otp/verify', {'phone': guardPhone, 'code': stub['code']});

  final memberships = jsonDecode(
    (await http.get(
      Uri.parse('$baseUrl/v1/auth/me/memberships'),
      headers: {'Authorization': 'Bearer ${verified['accessToken']}'},
    ))
        .body,
  ) as List<dynamic>;

  final scoped = await post('/v1/auth/refresh', {
    'refreshToken': verified['refreshToken'],
    'societyId': (memberships.first as Map<String, dynamic>)['societyId'],
  });

  return scoped['accessToken'] as String;
}

void main() {
  late bool up;

  setUpAll(() async {
    up = await apiIsUp();
    if (!up) {
      // ignore: avoid_print
      print('API not running on $baseUrl — airplane-mode acceptance test skipped.');
    }
  });

  test('a pass verifies with the network completely unavailable', () async {
    // Vectors signed by the server's own implementation, verified with no transport in
    // scope at all. If verification ever needed a request, there is nothing here to
    // serve it.
    final vectors = jsonDecode(
      File('../../packages/money/pass-vectors.json').readAsStringSync(),
    ) as Map<String, dynamic>;

    final keys = (vectors['publicKeys'] as Map<String, dynamic>)
        .map((k, v) => MapEntry(int.parse(k), v as String));
    final good = (vectors['cases'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .firstWhere((c) => c['expect'] == 'valid');

    final started = DateTime.now();
    final payload = await verifyPass(
      good['qr'] as String,
      keys,
      now: DateTime.fromMillisecondsSinceEpoch(
        good['verifyAtEpochMs'] as int,
        isUtc: true,
      ),
    );
    final elapsed = DateTime.now().difference(started);

    expect(payload.passId, isNotEmpty);
    // The SLO is 500ms at the barrier. Ed25519 verification is sub-millisecond; this
    // guards against someone later adding a lookup to this path.
    expect(elapsed.inMilliseconds, lessThan(500));
  });

  test('events queue while offline and nothing is lost', () async {
    final outbox = Outbox.inMemory();
    addTearDown(outbox.dispose);

    for (var i = 0; i < 5; i++) {
      outbox.add('gate_entry', {
        'direction': 'entry',
        'category': 'guest',
        'visitorName': 'Airplane $i',
        'verifiedOffline': true,
        'deviceTs': DateTime.now().toUtc().toIso8601String(),
      });
    }

    // Airplane mode: every call fails.
    final report = await SyncEngine(
      outbox: outbox,
      transport: (_) async => throw const TransientSyncFailure('airplane mode'),
    ).drain();

    expect(report.sent, 0);
    expect(report.parked, 0, reason: 'being offline must never discard an entry');
    expect(report.remaining, 5);
  });

  test('acceptance: offline scan, reconnect, replay — exactly once', () async {
    if (!up) return;

    final token = await guardToken();
    final outbox = Outbox.inMemory();
    addTearDown(outbox.dispose);

    final marker = 'AirplaneE2E${DateTime.now().millisecondsSinceEpoch}';

    final ids = <String>[];
    for (var i = 0; i < 3; i++) {
      ids.add(outbox.add('gate_entry', {
        'direction': 'entry',
        'category': 'guest',
        'visitorName': '$marker$i',
        'verifiedOffline': true,
        'deviceTs': DateTime.now().toUtc().toIso8601String(),
      }));
    }

    final client = GateApiClient(baseUrl: baseUrl, token: token);
    addTearDown(client.close);

    final first = await SyncEngine(outbox: outbox, transport: client.sync).drain();
    expect(first.sent, 3, reason: 'first upload should accept all three');
    expect(first.remaining, 0);

    final rows = <OutboxRow>[];
    for (var i = 0; i < ids.length; i++) {
      rows.add(OutboxRow(
        id: ids[i],
        kind: 'gate_entry',
        payload: {
          'direction': 'entry',
          'category': 'guest',
          'visitorName': '$marker$i',
          'verifiedOffline': true,
          'deviceTs': DateTime.now().toUtc().toIso8601String(),
        },
        state: OutboxState.pending,
        attempts: 0,
        createdAt: DateTime.now(),
      ));
    }

    for (var replay = 1; replay <= 3; replay++) {
      final response = await client.sync(rows);
      for (final id in ids) {
        expect(
          response.outcomes[id],
          'duplicate',
          reason: 'replay $replay of $id must be a duplicate, never a new row',
        );
      }
    }

    // `/v1/gate/events` filters by unitId and these entries carry none, so the list
    // that answers "did the server store them" is the still-inside list: an entry with
    // no matching exit, which is exactly what three unmatched entries are.
    final res = await http.get(
      Uri.parse('$baseUrl/v1/gate/inside'),
      headers: {'Authorization': 'Bearer $token'},
    );
    final events = (jsonDecode(res.body) as List<dynamic>).cast<Map<String, dynamic>>();
    final mine = events
        .where((e) => (e['visitorName'] as String? ?? '').startsWith(marker))
        .toList();

    expect(mine, hasLength(3), reason: '3 events sent 4 times must still be 3 rows');
    expect(mine.map((e) => e['id'] as String).toSet(), ids.toSet());
  }, timeout: const Timeout(Duration(minutes: 2)));
}
