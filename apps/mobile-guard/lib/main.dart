/// WatchMyGate — guard app.
///
/// Designed for the device it actually runs on: a cheap, shared Android handset held in
/// one hand, in sunlight, by someone with a queue of cars behind them. Every screen is
/// large type, high contrast, and one decision at a time.
///
/// The whole app is built around one inversion: **nothing waits on the network.** A pass
/// is verified locally against a cached key, the entry is written to an encrypted local
/// outbox, and upload happens whenever there is signal. At an Indian apartment gate no
/// signal is the normal condition, not an edge case.
library;

import 'package:flutter/material.dart';

import 'l10n/strings.dart';
import 'offline/outbox.dart';
import 'offline/pass_verifier.dart';
import 'ui/scan_screen.dart';
import 'ui/verdict.dart';

void main() {
  runApp(const GuardApp());
}

class GuardApp extends StatefulWidget {
  const GuardApp({super.key});

  @override
  State<GuardApp> createState() => _GuardAppState();
}

class _GuardAppState extends State<GuardApp> {
  AppLanguage _language = AppLanguage.english;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'WatchMyGate Guard',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF6E2436),
          brightness: Brightness.light,
        ),
        // Larger than a consumer app's default throughout. The screen is read at arm's
        // length in daylight, often by someone who needs reading glasses they are not
        // wearing.
        textTheme: const TextTheme(
          bodyLarge: TextStyle(fontSize: 18),
          bodyMedium: TextStyle(fontSize: 16),
          titleLarge: TextStyle(fontSize: 24, fontWeight: FontWeight.w700),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(64),
            textStyle: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
          ),
        ),
      ),
      home: ScanScreen(
        language: _language,
        onLanguageChanged: (l) => setState(() => _language = l),
      ),
    );
  }
}

/// Everything the gate screen needs, in one place.
///
/// Deliberately not a state-management framework. The app has one screen that matters
/// and a queue behind it; a provider graph would add indirection to something a guard's
/// life depends on being obvious.
class GateState {
  GateState({required this.outbox, required this.signingKeys});

  final Outbox outbox;
  final Map<int, String> signingKeys;

  /// Verify a scanned code. Never touches the network.
  Future<Verdict> check(String qr, {String? societyId}) async {
    try {
      final payload = await verifyPass(
        qr,
        signingKeys,
        expectedSocietyId: societyId,
      );
      return verdictFor(payload);
    } on PassException catch (e) {
      return verdictFor(e);
    } catch (_) {
      // Anything unexpected refuses. Failing open at a gate has no acceptable version.
      return verdictFor(null);
    }
  }

  /// Record an admission. Returns the outbox id, which is also the server's dedup key.
  String admit(PassPayload pass, {String category = 'guest'}) {
    return outbox.add('gate_entry', {
      'direction': 'entry',
      'category': category,
      'passId': pass.passId,
      'unitId': pass.unitId,
      'verifiedOffline': true,
      'deviceTs': DateTime.now().toUtc().toIso8601String(),
    });
  }

  int get queued => outbox.pending(limit: 1000).length;
}
