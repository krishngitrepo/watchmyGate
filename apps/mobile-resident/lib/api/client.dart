/// The API client.
///
/// The resident app is a thin client by design. Every rule that decides an amount —
/// GST slabs, per-sq-ft formulas, late-fee interest, rounding — lives once on the
/// server, and this app renders what it is told. That is not laziness: the total a
/// resident sees and the total filed for GST cannot differ by a paisa, and the only way
/// to guarantee that is to have one implementation rather than two kept in step.
///
/// So there is no money arithmetic anywhere in this app. Amounts arrive as strings and
/// are displayed as strings.
library;

import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Thrown for anything the server refused. Carries the server's own message, which is
/// written for a resident to read.
class ApiException implements Exception {
  const ApiException(this.statusCode, this.message);

  final int statusCode;
  final String message;

  bool get isAuth => statusCode == 401 || statusCode == 403;

  @override
  String toString() => message;
}

class Session {
  const Session({
    required this.accessToken,
    required this.refreshToken,
    this.societyId,
  });

  final String accessToken;
  final String refreshToken;
  final String? societyId;
}

/// Tokens live in the platform keystore, never in SharedPreferences.
///
/// A refresh token is a long-lived credential for someone's home: it approves visitors
/// and shows what they owe. `resetOnError: false` for the same reason as the guard app —
/// silently discarding a token the app then cannot distinguish from "never signed in"
/// makes a session bug look like a logout.
const _storage = FlutterSecureStorage(
  aOptions: AndroidOptions(resetOnError: false),
);

class ApiClient {
  ApiClient({required this.baseUrl, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  Session? _session;

  Session? get session => _session;
  bool get isSignedIn => _session?.societyId != null;

  Future<void> restore() async {
    final access = await _storage.read(key: 'wmg.access');
    final refresh = await _storage.read(key: 'wmg.refresh');
    final society = await _storage.read(key: 'wmg.society');
    if (access != null && refresh != null) {
      _session = Session(
        accessToken: access,
        refreshToken: refresh,
        societyId: society,
      );
    }
  }

  Future<void> _persist(Session s) async {
    _session = s;
    await _storage.write(key: 'wmg.access', value: s.accessToken);
    await _storage.write(key: 'wmg.refresh', value: s.refreshToken);
    if (s.societyId != null) {
      await _storage.write(key: 'wmg.society', value: s.societyId);
    }
  }

  Future<void> signOut() async {
    _session = null;
    await _storage.deleteAll();
  }

  Future<dynamic> _send(
    String method,
    String path, {
    Object? body,
    bool retryOnAuth = true,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = {
      'Content-Type': 'application/json',
      if (_session != null) 'Authorization': 'Bearer ${_session!.accessToken}',
    };

    late http.Response res;
    try {
      res = switch (method) {
        'GET' => await _client.get(uri, headers: headers),
        'DELETE' => await _client.delete(uri, headers: headers),
        _ => await _client.post(
            uri,
            headers: headers,
            body: jsonEncode(body ?? const {}),
          ),
      };
    } catch (e) {
      throw ApiException(0, 'Could not reach the server. Check your connection.');
    }

    // An expired access token is ordinary — they last minutes. Refresh once and retry,
    // rather than showing a resident a login screen mid-tap on an approval.
    if (res.statusCode == 401 && retryOnAuth && _session != null) {
      if (await _refresh()) {
        return _send(method, path, body: body, retryOnAuth: false);
      }
    }

    final decoded = res.body.isEmpty ? null : jsonDecode(res.body);

    if (res.statusCode >= 400) {
      final message = decoded is Map && decoded['error'] is Map
          ? (decoded['error']['message'] as String? ?? 'Something went wrong.')
          : 'Something went wrong.';
      throw ApiException(res.statusCode, message);
    }
    return decoded;
  }

  Future<bool> _refresh() async {
    final s = _session;
    if (s == null) return false;
    try {
      final res = await _client.post(
        Uri.parse('$baseUrl/v1/auth/refresh'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'refreshToken': s.refreshToken,
          if (s.societyId != null) 'societyId': s.societyId,
        }),
      );
      if (res.statusCode >= 400) return false;
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      await _persist(Session(
        accessToken: body['accessToken'] as String,
        refreshToken: body['refreshToken'] as String,
        societyId: s.societyId,
      ));
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<T> get<T>(String path) async => await _send('GET', path) as T;
  Future<T> post<T>(String path, [Object? body]) async =>
      await _send('POST', path, body: body) as T;
  Future<void> delete(String path) async => _send('DELETE', path);

  // ------------------------------------------------------------------ auth

  Future<void> requestOtp(String phone) =>
      _send('POST', '/v1/auth/otp/request', body: {'phone': phone});

  /// Verify, then discover memberships.
  ///
  /// The first verify sends no societyId deliberately. One person can be an owner in one
  /// society and on the committee in another, so the society is chosen after identity is
  /// proven rather than guessed beforehand — and the server refuses a session scoped to
  /// a society you are not a member of anyway.
  Future<List<dynamic>> verifyOtp(String phone, String code) async {
    final body = await _send(
      'POST',
      '/v1/auth/otp/verify',
      body: {'phone': phone, 'code': code},
    ) as Map<String, dynamic>;

    await _persist(Session(
      accessToken: body['accessToken'] as String,
      refreshToken: body['refreshToken'] as String,
    ));

    return await _send('GET', '/v1/auth/me/memberships') as List<dynamic>;
  }

  Future<void> chooseSociety(String societyId) async {
    final s = _session!;
    final body = await _send('POST', '/v1/auth/refresh', body: {
      'refreshToken': s.refreshToken,
      'societyId': societyId,
    }) as Map<String, dynamic>;

    await _persist(Session(
      accessToken: body['accessToken'] as String,
      refreshToken: body['refreshToken'] as String,
      societyId: societyId,
    ));
  }

  void close() => _client.close();
}
