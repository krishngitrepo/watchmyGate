/// Sign in — phone and a one-time code, no passwords.
///
/// Two steps rather than one screen: a person can be an owner in one society and on the
/// committee in another, so the society is chosen after identity is proven rather than
/// guessed beforehand.
library;

import 'package:flutter/material.dart';

import '../api/client.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key, required this.api, required this.onSignedIn});

  final ApiClient api;
  final VoidCallback onSignedIn;

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

enum _Stage { phone, code, society }

class _SignInScreenState extends State<SignInScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();

  _Stage _stage = _Stage.phone;
  List<dynamic> _memberships = const [];
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Text(
                'WatchMyGate',
                style: TextStyle(fontSize: 30, fontWeight: FontWeight.w800),
              ),
              const SizedBox(height: 8),
              Text(
                switch (_stage) {
                  _Stage.phone => 'Sign in with the number your society has on record.',
                  _Stage.code => 'Enter the 6-digit code we sent you.',
                  _Stage.society => 'Which society would you like to open?',
                },
                style: const TextStyle(fontSize: 16, color: Colors.black54),
              ),
              const SizedBox(height: 24),

              if (_error != null) ...[
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: const Color(0xFFF7E6E1),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(_error!, style: const TextStyle(color: Color(0xFFA8321E))),
                ),
                const SizedBox(height: 16),
              ],

              if (_stage == _Stage.phone) ...[
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  autofillHints: const [AutofillHints.telephoneNumber],
                  decoration: const InputDecoration(
                    labelText: 'Mobile number',
                    hintText: '+91 99000 00002',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy
                      ? null
                      : () => _run(() async {
                            await widget.api.requestOtp(_phone.text.trim());
                            setState(() => _stage = _Stage.code);
                          }),
                  child: Text(_busy ? 'Sending…' : 'Send code'),
                ),
              ],

              if (_stage == _Stage.code) ...[
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  autofillHints: const [AutofillHints.oneTimeCode],
                  maxLength: 6,
                  style: const TextStyle(fontSize: 26, letterSpacing: 8),
                  textAlign: TextAlign.center,
                  decoration: const InputDecoration(
                    border: OutlineInputBorder(),
                    counterText: '',
                  ),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy
                      ? null
                      : () => _run(() async {
                            final mine = await widget.api.verifyOtp(
                              _phone.text.trim(),
                              _code.text.trim(),
                            );
                            if (mine.isEmpty) {
                              await widget.api.signOut();
                              setState(() {
                                _stage = _Stage.phone;
                                _error = 'That number is not registered with any '
                                    'society yet. Ask your committee to add you.';
                              });
                              return;
                            }
                            if (mine.length == 1) {
                              await widget.api.chooseSociety(
                                (mine.first as Map<String, dynamic>)['societyId'] as String,
                              );
                              widget.onSignedIn();
                              return;
                            }
                            setState(() {
                              _memberships = mine;
                              _stage = _Stage.society;
                            });
                          }),
                  child: Text(_busy ? 'Checking…' : 'Sign in'),
                ),
                TextButton(
                  onPressed: () => setState(() => _stage = _Stage.phone),
                  child: const Text('Use a different number'),
                ),
              ],

              if (_stage == _Stage.society)
                for (final m in _memberships.cast<Map<String, dynamic>>())
                  Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: OutlinedButton(
                      onPressed: _busy
                          ? null
                          : () => _run(() async {
                                await widget.api
                                    .chooseSociety(m['societyId'] as String);
                                widget.onSignedIn();
                              }),
                      child: ListTile(
                        title: Text(m['societyName'] as String? ?? 'Society'),
                        subtitle: Text(
                          (m['roles'] as List<dynamic>? ?? [])
                              .join(', ')
                              .replaceAll('_', ' '),
                        ),
                      ),
                    ),
                  ),
            ],
          ),
        ),
      ),
    );
  }
}
