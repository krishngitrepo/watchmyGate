/// Visitor approval — the feature the whole product hangs on.
///
/// A delivery agent is at the gate, the guard has a queue, and a resident has to answer
/// in seconds. Everything here is shaped by that:
///
/// **One tap, no confirmation dialog.** A "are you sure?" step doubles the time and adds
/// nothing — the decision is reversible by calling the gate, and the cost of a mis-tap is
/// far smaller than the cost of a resident who gives up and phones the guard instead.
///
/// **The remaining time is shown, counting down.** The approval ladder escalates at 20s,
/// 45s and 90s whether or not the resident acts. Hiding that would make the app feel
/// broken when a request vanishes mid-tap; showing it explains what happened.
///
/// **Deny needs no reason.** Asking one is how you get residents who approve strangers
/// because refusing is more work than allowing.
library;

import '../api/client.dart';

/// The rungs, mirroring `apps/api/src/modules/gate/ladder.ts`.
///
/// Duplicated here purely to render a countdown; the server remains the only thing that
/// actually advances a ladder. If these drift the display is wrong, never the decision.
const ladderSeconds = [0, 20, 45, 90];

class PendingApproval {
  const PendingApproval({
    required this.id,
    required this.category,
    required this.requestedAt,
    this.visitorName,
    this.visitorPhone,
    this.unitLabel,
    this.photoUrl,
  });

  factory PendingApproval.fromJson(Map<String, dynamic> json) => PendingApproval(
        id: json['id'] as String,
        category: json['category'] as String? ?? 'guest',
        requestedAt: DateTime.parse(json['requestedAt'] as String? ??
            json['createdAt'] as String? ??
            DateTime.now().toUtc().toIso8601String()),
        visitorName: json['visitorName'] as String?,
        visitorPhone: json['visitorPhone'] as String?,
        unitLabel: json['unitLabel'] as String?,
        photoUrl: json['photoUrl'] as String?,
      );

  final String id;
  final String category;
  final DateTime requestedAt;
  final String? visitorName;
  final String? visitorPhone;
  final String? unitLabel;
  final String? photoUrl;

  /// Seconds until the next rung fires, or null once the ladder is exhausted.
  int? secondsToNextRung({DateTime? now}) {
    final elapsed =
        (now ?? DateTime.now()).toUtc().difference(requestedAt.toUtc()).inSeconds;
    for (final rung in ladderSeconds) {
      if (elapsed < rung) return rung - elapsed;
    }
    return null;
  }

  /// Which rung the request has reached — what the resident is told happened.
  int rungsFired({DateTime? now}) {
    final elapsed =
        (now ?? DateTime.now()).toUtc().difference(requestedAt.toUtc()).inSeconds;
    return ladderSeconds.where((r) => elapsed >= r).length;
  }

  /// True once the committee has been called. The request is no longer only theirs.
  bool escalated({DateTime? now}) => rungsFired(now: now) >= ladderSeconds.length;
}

class ApprovalsRepository {
  const ApprovalsRepository(this._api);

  final ApiClient _api;

  Future<List<PendingApproval>> pending() async {
    final rows = await _api.get<List<dynamic>>('/v1/gate/approvals/pending');
    return rows
        .cast<Map<String, dynamic>>()
        .map(PendingApproval.fromJson)
        .toList();
  }

  /// Approve or deny.
  ///
  /// The server is the authority on whether this is still open — a resident tapping
  /// approve on a request the ladder already resolved gets told so rather than being
  /// shown a success they did not cause.
  Future<String> decide(String id, {required bool allow}) async {
    final body = await _api.post<Map<String, dynamic>>(
      '/v1/gate/approvals/$id/decision',
      {'decision': allow ? 'approved' : 'denied'},
    );
    return body['state'] as String? ?? (allow ? 'approved' : 'denied');
  }

  /// Pre-approve an expected visitor, producing a shareable pass.
  Future<Map<String, dynamic>> preApprove({
    required String unitId,
    required String visitorName,
    String? visitorPhone,
    required DateTime validFrom,
    required DateTime validTo,
    int maxUses = 1,
  }) async {
    return _api.post<Map<String, dynamic>>('/v1/gate/passes', {
      'unitId': unitId,
      'visitorName': visitorName,
      // The conditional form states the intent — "include the phone only if we have
      // one" — more plainly than the null-aware marker does here.
      // ignore: use_null_aware_elements
      if (visitorPhone != null) 'visitorPhone': visitorPhone,
      'validFrom': validFrom.toUtc().toIso8601String(),
      'validTo': validTo.toUtc().toIso8601String(),
      'maxUses': maxUses,
    });
  }
}
