/// The gate screen.
///
/// One job: point the camera at a QR, get an answer big enough to read at arm's length,
/// and admit or refuse. Everything else is behind a menu.
///
/// The queue count is always visible. A guard needs to know the device is holding
/// unsent entries without having to go looking, because that number climbing through a
/// shift is the first sign the gate has gone dark — and on a device with no signal it is
/// the only sign there is.
library;

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../l10n/strings.dart';
import '../offline/pass_verifier.dart';
import 'verdict.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({
    super.key,
    required this.language,
    required this.onLanguageChanged,
    this.signingKeys = const {},
    this.onAdmit,
    this.queuedCount = 0,
  });

  final AppLanguage language;
  final ValueChanged<AppLanguage> onLanguageChanged;
  final Map<int, String> signingKeys;
  final void Function(PassPayload pass)? onAdmit;
  final int queuedCount;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
    detectionSpeed: DetectionSpeed.noDuplicates,
  );

  Verdict? _verdict;
  bool _busy = false;

  Strings get _s => Strings(widget.language);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_busy || _verdict != null) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null || raw.isEmpty) return;

    setState(() => _busy = true);
    try {
      final payload = await verifyPass(raw, widget.signingKeys);
      setState(() => _verdict = verdictFor(payload));
    } on PassException catch (e) {
      setState(() => _verdict = verdictFor(e));
    } catch (_) {
      setState(() => _verdict = verdictFor(null));
    } finally {
      setState(() => _busy = false);
    }
  }

  void _clear() => setState(() => _verdict = null);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_s('scan')),
        actions: [
          // Always visible. A climbing queue is the only sign of a dark gate on a
          // device with no signal.
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Center(
              child: Text(
                '${widget.queuedCount} ${_s('queued')}',
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ),
          PopupMenuButton<AppLanguage>(
            icon: const Icon(Icons.translate),
            onSelected: widget.onLanguageChanged,
            itemBuilder: (_) => [
              for (final l in AppLanguage.values)
                PopupMenuItem(value: l, child: Text(l.label)),
            ],
          ),
        ],
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          if (_verdict != null) _VerdictSheet(
            verdict: _verdict!,
            strings: _s,
            onAdmit: () {
              final pass = _verdict!.payload;
              if (pass != null) widget.onAdmit?.call(pass);
              _clear();
            },
            onDismiss: _clear,
          ),
        ],
      ),
    );
  }
}

/// The answer, sized to be read without concentrating.
class _VerdictSheet extends StatelessWidget {
  const _VerdictSheet({
    required this.verdict,
    required this.strings,
    required this.onAdmit,
    required this.onDismiss,
  });

  final Verdict verdict;
  final Strings strings;
  final VoidCallback onAdmit;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: verdict.colour,
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(
            verdict.canAdmit ? Icons.check_circle : Icons.block,
            size: 96,
            color: Colors.white,
          ),
          const SizedBox(height: 20),
          Text(
            verdict.headline(strings),
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontSize: 34,
              fontWeight: FontWeight.w800,
              color: Colors.white,
              height: 1.15,
            ),
          ),
          if (verdict.payload != null) ...[
            const SizedBox(height: 14),
            Text(
              '${strings('flat')} ${verdict.payload!.unitId.substring(0, 8)}',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 20, color: Colors.white70),
            ),
          ],
          if (verdict.shouldEscalate) ...[
            const SizedBox(height: 14),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: Colors.white24,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                strings('deny'),
                textAlign: TextAlign.center,
                style: const TextStyle(fontSize: 18, color: Colors.white),
              ),
            ),
          ],
          const Spacer(),
          if (verdict.canAdmit)
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: verdict.colour,
              ),
              onPressed: onAdmit,
              child: Text(strings('allow')),
            )
          else
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: verdict.colour,
              ),
              onPressed: onDismiss,
              child: Text(strings('scan')),
            ),
        ],
      ),
    );
  }
}
