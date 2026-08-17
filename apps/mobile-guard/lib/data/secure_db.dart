/// The encrypted local database.
///
/// Guard handsets are society property, shared between shifts, frequently cheap Android
/// hardware, and they leave the premises. Whatever is on disk has to be useless to
/// whoever picks the device up.
///
/// So the SQLite file is SQLCipher-encrypted and the key lives in the Android Keystore —
/// hardware-backed where the device supports it — never in the file, never in
/// SharedPreferences, never in the APK. A key stored beside the data it protects is
/// decoration.
///
/// The key is generated on first run and never leaves the device. There is deliberately
/// no recovery path: if the keystore entry is lost the local queue is unreadable, which
/// is the correct trade. The alternative is an escrow that also lets an attacker in, and
/// anything already synced is on the server anyway.
library;

import 'dart:convert';
import 'dart:math';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3/sqlite3.dart';

const _keyAlias = 'wmg.guard.dbkey.v1';

/// Defaults are the strong path in flutter_secure_storage 11: AES-GCM for the data with
/// RSA-OAEP key wrapping in the Android Keystore. The old `encryptedSharedPreferences`
/// flag is gone because that is now simply how it works.
///
/// `resetOnError: false` is the important one and is deliberately not the default. If the
/// keystore entry cannot be decrypted, the default silently discards it and returns null —
/// this code would then generate a *new* key, and the existing outbox would become
/// permanently unreadable with no message and no trace. On a device holding a night's
/// unsynced entries that is silent data loss. Failing loudly lets the guard be told to
/// sync before the device is wiped.
const _storage = FlutterSecureStorage(
  aOptions: AndroidOptions(resetOnError: false),
);

/// Fetch the database key, generating one on first run.
Future<String> databaseKey() async {
  final existing = await _storage.read(key: _keyAlias);
  if (existing != null && existing.isNotEmpty) return existing;

  // 32 bytes from a CSPRNG. `Random.secure()` maps to the platform's secure source.
  final rng = Random.secure();
  final bytes = List<int>.generate(32, (_) => rng.nextInt(256));
  final key = base64Url.encode(bytes);

  await _storage.write(key: _keyAlias, value: key);
  return key;
}

/// Open the encrypted database.
///
/// `PRAGMA key` must be the first statement on the connection — SQLCipher applies it
/// before any page is read, and issuing it later silently leaves the file unencrypted.
/// The `SELECT count(*) FROM sqlite_master` afterwards is not a formality: it is the only
/// way to learn the key was wrong, because SQLCipher fails at first read rather than at
/// the pragma.
Future<Database> openEncryptedDatabase({String? overridePath}) async {
  final key = await databaseKey();
  final dir = await getApplicationDocumentsDirectory();
  final path = overridePath ?? p.join(dir.path, 'guard.db');

  final db = sqlite3.open(path);
  db.execute("PRAGMA key = '$key';");

  try {
    db.select('SELECT count(*) FROM sqlite_master');
  } catch (e) {
    db.close();
    throw StateError(
      'The local database could not be opened. The device key may have been reset: $e',
    );
  }

  return db;
}

/// Wipe the local key. **Irreversible** — any unsynced queue becomes unreadable.
///
/// Used when a device is unbound from a society. Rotating the key is what actually makes
/// a decommissioned handset safe; deleting rows from a database whose key still exists
/// leaves them recoverable from the free pages.
Future<void> destroyDatabaseKey() => _storage.delete(key: _keyAlias);
