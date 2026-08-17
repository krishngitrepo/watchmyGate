/// WatchMyGate — resident app.
///
/// Four things a resident actually does: answer the gate, see what they owe, raise a
/// complaint, and press SOS. Everything else is secondary and lives behind those.
///
/// The home screen is the approvals list, not a dashboard. A dashboard is what you build
/// when you do not know what the user came for; a resident opening this app at 7pm came
/// because their phone buzzed about someone at the gate.
library;

import 'package:flutter/material.dart';

import 'api/client.dart';
import 'features/approvals.dart';
import 'ui/home_screen.dart';
import 'ui/sign_in_screen.dart';

/// Points at the local API by default; overridden at build time for a real deployment.
const apiBaseUrl = String.fromEnvironment(
  'WMG_API_URL',
  defaultValue: 'http://10.0.2.2:8080',
);

void main() {
  runApp(const ResidentApp());
}

class ResidentApp extends StatefulWidget {
  const ResidentApp({super.key});

  @override
  State<ResidentApp> createState() => _ResidentAppState();
}

class _ResidentAppState extends State<ResidentApp> {
  late final ApiClient _api = ApiClient(baseUrl: apiBaseUrl);
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _api.restore().whenComplete(() {
      if (mounted) setState(() => _ready = true);
    });
  }

  @override
  void dispose() {
    _api.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'WatchMyGate',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6E2436)),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            minimumSize: const Size.fromHeight(52),
            textStyle: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
          ),
        ),
      ),
      home: !_ready
          ? const Scaffold(body: Center(child: CircularProgressIndicator()))
          : _api.isSignedIn
              ? HomeScreen(api: _api, approvals: ApprovalsRepository(_api))
              : SignInScreen(
                  api: _api,
                  onSignedIn: () => setState(() {}),
                ),
    );
  }
}
