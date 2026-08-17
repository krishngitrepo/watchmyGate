/// The resident's home.
///
/// Approvals first, because that is what the buzz in their pocket was about. Dues,
/// complaints and SOS behind tabs.
///
/// The SOS button is on every tab, always in the same place. A panic control that moves,
/// or that requires navigating to find, is not a panic control.
library;

import 'dart:async';

import 'package:flutter/material.dart';

import '../api/client.dart';
import '../features/approvals.dart';
import '../features/money.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.api, required this.approvals});

  final ApiClient api;
  final ApprovalsRepository approvals;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;
  List<PendingApproval> _pending = const [];
  List<dynamic> _dues = const [];
  String? _error;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _refresh();
    // Polling stands in for push until FCM credentials exist. Five seconds because the
    // ladder's first escalation is at twenty — a slower poll would show a resident a
    // request that has already been answered by the standing rule.
    _poll = Timer.periodic(const Duration(seconds: 5), (_) => _refreshApprovals());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    await Future.wait([_refreshApprovals(), _refreshDues()]);
  }

  Future<void> _refreshApprovals() async {
    try {
      final rows = await widget.approvals.pending();
      if (mounted) setState(() => _pending = rows);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _refreshDues() async {
    try {
      final rows = await widget.api.get<List<dynamic>>('/v1/payments/outstanding');
      if (mounted) setState(() => _dues = rows);
    } on ApiException catch (_) {
      // Dues failing must not blank the approvals list — they are independent, and the
      // gate is the urgent one.
    }
  }

  Future<void> _decide(PendingApproval a, bool allow) async {
    // Removed from the list immediately. The resident tapped; leaving the card there
    // while a request completes invites a second tap on a decision already made.
    setState(() => _pending = _pending.where((p) => p.id != a.id).toList());
    try {
      await widget.approvals.decide(a.id, allow: allow);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
        _refreshApprovals();
      }
    }
  }

  Future<void> _sos() async {
    final type = await showModalBottomSheet<String>(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final t in const [
              ('medical', 'Medical'),
              ('fire', 'Fire'),
              ('gas', 'Gas leak'),
              ('security', 'Security'),
            ])
              ListTile(
                title: Text(t.$2, style: const TextStyle(fontSize: 20)),
                onTap: () => Navigator.pop(context, t.$1),
              ),
          ],
        ),
      ),
    );
    if (type == null) return;

    try {
      await widget.api.post('/v1/safety/sos', {'type': type});
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Alert sent. The gate has been told.')),
        );
      }
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('WatchMyGate'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await widget.api.signOut();
              if (mounted) setState(() {});
            },
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: switch (_tab) {
          0 => _Approvals(pending: _pending, error: _error, onDecide: _decide),
          _ => _Dues(dues: _dues),
        },
      ),
      // Always present, always in the same place.
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _sos,
        backgroundColor: const Color(0xFFB3261E),
        foregroundColor: Colors.white,
        icon: const Icon(Icons.emergency),
        label: const Text('SOS', style: TextStyle(fontWeight: FontWeight.w800)),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          NavigationDestination(
            icon: Badge(
              isLabelVisible: _pending.isNotEmpty,
              label: Text('${_pending.length}'),
              child: const Icon(Icons.doorbell_outlined),
            ),
            label: 'Gate',
          ),
          const NavigationDestination(
            icon: Icon(Icons.receipt_long_outlined),
            label: 'Dues',
          ),
        ],
      ),
    );
  }
}

class _Approvals extends StatelessWidget {
  const _Approvals({
    required this.pending,
    required this.error,
    required this.onDecide,
  });

  final List<PendingApproval> pending;
  final String? error;
  final void Function(PendingApproval, bool) onDecide;

  @override
  Widget build(BuildContext context) {
    if (pending.isEmpty) {
      return ListView(
        children: [
          const SizedBox(height: 120),
          Center(
            child: Text(
              error ?? 'Nobody is waiting at the gate.',
              style: const TextStyle(fontSize: 17, color: Colors.black54),
            ),
          ),
        ],
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: pending.length,
      itemBuilder: (_, i) {
        final a = pending[i];
        final left = a.secondsToNextRung();
        return Card(
          margin: const EdgeInsets.only(bottom: 16),
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  a.visitorName ?? a.category,
                  style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 4),
                Text(
                  a.category.replaceAll('_', ' '),
                  style: const TextStyle(fontSize: 16, color: Colors.black54),
                ),
                const SizedBox(height: 12),
                // Explains what is about to happen on its own, rather than letting a
                // request silently vanish mid-tap.
                Text(
                  a.escalated()
                      ? 'The committee has been called about this.'
                      : left != null
                          ? 'Answering in ${left}s, or the gate follows your standing rule.'
                          : 'No longer waiting on you.',
                  style: const TextStyle(fontSize: 14, color: Colors.black45),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => onDecide(a, false),
                        child: const Padding(
                          padding: EdgeInsets.symmetric(vertical: 12),
                          child: Text('Deny', style: TextStyle(fontSize: 18)),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: FilledButton(
                        onPressed: () => onDecide(a, true),
                        child: const Text('Allow'),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Dues extends StatelessWidget {
  const _Dues({required this.dues});

  final List<dynamic> dues;

  @override
  Widget build(BuildContext context) {
    if (dues.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 120),
          Center(
            child: Text(
              'Nothing outstanding.',
              style: TextStyle(fontSize: 17, color: Colors.black54),
            ),
          ),
        ],
      );
    }

    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: dues.length,
      itemBuilder: (_, i) {
        final row = dues[i] as Map<String, dynamic>;
        // Rendered exactly as the server sent it. No arithmetic happens in this app.
        final amount = row['outstanding'] as String? ?? '0';
        return ListTile(
          title: Text(row['number'] as String? ?? row['unitNumber'] as String? ?? 'Flat'),
          subtitle: Text(row['dueDate'] as String? ?? ''),
          trailing: Text(
            formatRupees(amount),
            style: TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w700,
              fontFeatures: const [FontFeature.tabularFigures()],
              color: isOutstanding(amount) ? const Color(0xFFA8321E) : null,
            ),
          ),
        );
      },
    );
  }
}
