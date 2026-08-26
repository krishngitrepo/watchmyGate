/**
 * Gate operations: pass issuance, and draining the guard app's offline outbox.
 *
 * The design constraint that shapes everything here: **a gate has no signal.** Indian
 * apartment gates are concrete boxes at the edge of a compound, and the guard's handset
 * is a cheap Android on a prepaid SIM. Offline is the normal condition, not the outage.
 *
 * So the guard app never waits for us. It records entries locally, verifies passes
 * against a cached public key, and drains its outbox whenever it happens to have a bar
 * of signal. Our job is to accept that drain without ever losing or duplicating an
 * event, and without ever wedging.
 */

import { Injectable } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import { schema } from "@watchmygate/db";

import { NotFoundError, ValidationError } from "../../common/errors.js";
import { AuditService } from "../../common/audit.service.js";
import { currentContext, tx } from "../../common/tenant-context.js";
import { driftSeconds, DRIFT_ALERT_SECONDS, type VisitorCategory } from "./ladder.js";
import {
  generateKeypair,
  KEY_CACHE_DEPTH,
  newSalt,
  signPass,
  visitorHash,
  type PassPayload,
} from "./passes.js";

/** One entry as the guard app recorded it, possibly hours ago and offline. */
export interface OutboxEvent {
  /** Client-generated UUID. This IS the deduplication key — see `sync`. */
  id: string;
  gateId?: string | undefined;
  unitId?: string | undefined;
  passId?: string | undefined;
  direction: "entry" | "exit";
  category: VisitorCategory;
  visitorName?: string | undefined;
  visitorPhone?: string | undefined;
  vehicleNumber?: string | undefined;
  photoKey?: string | undefined;
  verifiedOffline?: boolean | undefined;
  /** The handset's clock at the moment of the entry. Assumed wrong.  */
  deviceTs: string;
}

export type SyncOutcome =
  | { id: string; status: "accepted" }
  | { id: string; status: "duplicate" }
  | { id: string; status: "rejected"; reason: string };

export interface SyncResult {
  results: SyncOutcome[];
  accepted: number;
  duplicates: number;
  rejected: number;
  /** Worst clock drift seen in this batch, so the app can prompt a time fix. */
  maxDriftSeconds: number;
  driftWarning: boolean;
  serverTime: string;
}

@Injectable()
export class GateService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Drain a batch from a guard device.
   *
   * Three properties make this safe to call repeatedly from a flaky network:
   *
   * 1. **Idempotent.** The event id is generated on the handset (UUIDv7, so it also
   *    sorts by time) and is the primary key. Replaying a batch ten times inserts each
   *    event once. There is no separate dedup table to drift out of sync — the
   *    constraint that enforces it is the one the row is stored under.
   *
   * 2. **Per-event isolation.** One malformed event does not fail the batch. If it did,
   *    a single bad row would wedge that handset's outbox forever, and the guard would
   *    be told to reinstall the app — losing every unsynced entry with it. Bad events
   *    are reported back individually so the device can drop them and move on.
   *
   * 3. **Server time wins.** `device_ts` is recorded but never used for business logic.
   *    The drift is computed and stored so an audit can show both.
   */
  async sync(events: readonly OutboxEvent[]): Promise<SyncResult> {
    const { societyId } = currentContext();
    const serverTs = new Date();

    if (events.length > 500) {
      // A larger batch is a client bug or an attempt to exhaust a transaction; the app
      // pages at 200. Reject rather than let one request hold a connection open.
      throw new ValidationError(
        "Too many events in one batch. Send at most 500 at a time.",
      );
    }

    const results: SyncOutcome[] = [];
    let maxDrift = 0;

    for (const event of events) {
      let deviceTs: Date;
      try {
        deviceTs = this.parseDeviceTs(event);
      } catch (error) {
        results.push({
          id: event.id,
          status: "rejected",
          reason: (error as Error).message,
        });
        continue;
      }

      const drift = driftSeconds(deviceTs, serverTs);
      if (Math.abs(drift) > Math.abs(maxDrift)) maxDrift = drift;

      try {
        // Each event is its own transaction. A rejection rolls back only that event,
        // which is what lets the rest of the batch land.
        const inserted = await tx(async (db) => {
          const rows = await db
            .insert(schema.gateEvents)
            .values({
              id: event.id,
              societyId,
              gateId: event.gateId ?? null,
              unitId: event.unitId ?? null,
              passId: event.passId ?? null,
              guardPersonId: currentContext().personId,
              direction: event.direction,
              category: event.category,
              visitorName: event.visitorName ?? null,
              visitorPhone: event.visitorPhone ?? null,
              vehicleNumber: event.vehicleNumber ?? null,
              photoKey: event.photoKey ?? null,
              verifiedOffline: event.verifiedOffline ?? false,
              deviceTs,
              serverTs,
              clockDriftSeconds: drift,
              syncedAt: serverTs,
            })
            // The whole idempotency story, in one clause.
            .onConflictDoNothing({ target: schema.gateEvents.id })
            .returning({ id: schema.gateEvents.id });

          return rows.length > 0;
        });

        results.push({ id: event.id, status: inserted ? "accepted" : "duplicate" });
      } catch (error) {
        results.push({
          id: event.id,
          status: "rejected",
          reason: this.explain(error),
        });
      }
    }

    // Count a pass use only for events that landed now, so a replayed batch cannot
    // burn through a visitor's remaining entries.
    await this.countPassUses(
      events.filter(
        (e) =>
          e.passId &&
          results.some((r) => r.id === e.id && r.status === "accepted"),
      ),
    );

    return {
      results,
      accepted: results.filter((r) => r.status === "accepted").length,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      rejected: results.filter((r) => r.status === "rejected").length,
      maxDriftSeconds: maxDrift,
      driftWarning: Math.abs(maxDrift) > DRIFT_ALERT_SECONDS,
      // The handset uses this to correct its own clock display.
      serverTime: serverTs.toISOString(),
    };
  }

  private parseDeviceTs(event: OutboxEvent): Date {
    const parsed = new Date(event.deviceTs);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError("deviceTs is not a valid timestamp.");
    }
    // A handset whose clock has reset to 1970 still produces usable entries — the drift
    // is recorded and server_ts is what counts — but a date this wrong means the
    // reading is noise rather than data, so it is worth flagging on the event itself.
    return parsed;
  }

  private explain(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("foreign key")) {
      return "References a unit or gate that does not exist in this society.";
    }
    if (message.includes("invalid input value for enum")) {
      return "Unrecognised direction or visitor category.";
    }
    if (message.includes("row-level security")) {
      // Should be unreachable: society_id is set by us, not the client.
      return "Rejected by tenant isolation.";
    }
    return "Could not be recorded.";
  }

  /** Increment `uses` for passes actually admitted, and retire spent ones. */
  private async countPassUses(events: readonly OutboxEvent[]): Promise<void> {
    const entryPasses = events
      .filter((e) => e.direction === "entry" && e.passId)
      .map((e) => e.passId!);

    if (entryPasses.length === 0) return;

    await tx(async (db) => {
      for (const passId of entryPasses) {
        await db
          .update(schema.visitorPasses)
          .set({
            uses: sql`${schema.visitorPasses.uses} + 1`,
            // Retire it in the same statement it is spent, so there is no window in
            // which a single-use pass reads as still active.
            status: sql`CASE
              WHEN ${schema.visitorPasses.uses} + 1 >= ${schema.visitorPasses.maxUses}
              THEN 'used'::pass_status
              ELSE ${schema.visitorPasses.status}
            END`,
            updatedAt: new Date(),
          })
          .where(eq(schema.visitorPasses.id, passId));
      }
    });
  }

  /**
   * Issue a signed, offline-verifiable visitor pass.
   *
   * The QR carries a hash of the visitor, never their name or number — it gets
   * photographed and forwarded on WhatsApp, so it must not be a readable disclosure of
   * who is visiting whom.
   */
  async issuePass(input: {
    unitId: string;
    visitorName: string;
    visitorPhone?: string | undefined;
    category: VisitorCategory;
    vehicleNumber?: string | undefined;
    validFrom: Date;
    validTo: Date;
    maxUses?: number | undefined;
    holderPublicKey?: string | undefined;
  }): Promise<{
    passId: string;
    qrValue: string;
    validFrom: Date;
    validTo: Date;
    screenshotProof: boolean;
  }> {
    const { societyId, personId } = currentContext();

    if (input.validTo <= input.validFrom) {
      throw new ValidationError("The pass must end after it starts.");
    }

    const { keyVersion, privatePem } = await this.activeSigningKey();
    const salt = newSalt();
    const hash = visitorHash(input.visitorName, input.visitorPhone ?? "", salt);

    return tx(async (db) => {
      const [row] = await db
        .insert(schema.visitorPasses)
        .values({
          societyId,
          unitId: input.unitId,
          createdBy: personId,
          visitorName: input.visitorName,
          visitorPhone: input.visitorPhone ?? null,
          visitorHash: hash,
          visitorSalt: salt,
          category: input.category,
          vehicleNumber: input.vehicleNumber ?? null,
          validFrom: input.validFrom,
          validTo: input.validTo,
          maxUses: input.maxUses ?? 1,
          keyVersion,
          // Placeholder: the QR embeds the pass id, which the database assigns.
          qrValue: "",
        })
        .returning({ id: schema.visitorPasses.id });

      const passId = row!.id;
      const payload: PassPayload = {
        passId,
        societyId,
        unitId: input.unitId,
        validFrom: input.validFrom,
        validTo: input.validTo,
        maxUses: input.maxUses ?? 1,
        visitorHash: hash,
        keyVersion,
        // Present only when the resident's device registered a key. Its absence issues a
        // v1 pass, which still works everywhere and is not screenshot-proof — societies
        // have handsets and apps that predate v2, and refusing them would break the gate.
        ...(input.holderPublicKey ? { holderPublicKey: input.holderPublicKey } : {}),
      };
      const qrValue = signPass(payload, privatePem);

      await db
        .update(schema.visitorPasses)
        .set({ qrValue })
        .where(eq(schema.visitorPasses.id, passId));

      return {
        passId,
        qrValue,
        validFrom: input.validFrom,
        validTo: input.validTo,
        // Told to the caller so a resident app can say plainly whether this pass is safe
        // to forward. A society should be able to see how much of its estate is still on
        // the format a photograph defeats.
        screenshotProof: Boolean(input.holderPublicKey),
      };
    });
  }

  /**
   * Public keys a guard device should cache, newest first.
   *
   * More than one, because a pass signed just before a rotation must still verify on a
   * handset that has not synced since. Handing out only the current key would mean
   * every rotation locks out every device that is offline that day — which is most of
   * them, which is the entire problem we are solving.
   */
  async publicKeysForDevice(): Promise<
    Array<{ keyVersion: number; publicKey: string }>
  > {
    return tx(async (db) =>
      db
        .select({
          keyVersion: schema.societySigningKeys.keyVersion,
          publicKey: schema.societySigningKeys.publicKey,
        })
        .from(schema.societySigningKeys)
        .orderBy(desc(schema.societySigningKeys.keyVersion))
        .limit(KEY_CACHE_DEPTH),
    );
  }

  /**
   * The society's current signing key, creating the first one on demand.
   *
   * The private key belongs in Secret Manager; `privateKeyRef` holds the path. Until
   * that is wired, local development keeps it inline and the reference records that
   * clearly rather than pretending otherwise.
   */
  private async activeSigningKey(): Promise<{ keyVersion: number; privatePem: string }> {
    const { societyId } = currentContext();

    return tx(async (db) => {
      const [existing] = await db
        .select()
        .from(schema.societySigningKeys)
        .where(gte(schema.societySigningKeys.validFrom, new Date(0)))
        .orderBy(desc(schema.societySigningKeys.keyVersion))
        .limit(1);

      if (existing) {
        const pem = this.readPrivateKey(existing.privateKeyRef);
        return { keyVersion: existing.keyVersion, privatePem: pem };
      }

      const { privatePem, publicB64 } = generateKeypair();
      const [created] = await db
        .insert(schema.societySigningKeys)
        .values({
          societyId,
          keyVersion: 1,
          publicKey: publicB64,
          privateKeyRef: `inline:${Buffer.from(privatePem).toString("base64")}`,
          validFrom: new Date(),
        })
        .returning({ keyVersion: schema.societySigningKeys.keyVersion });

      return { keyVersion: created!.keyVersion, privatePem };
    });
  }

  private readPrivateKey(ref: string): string {
    if (ref.startsWith("inline:")) {
      return Buffer.from(ref.slice("inline:".length), "base64").toString("utf8");
    }
    // Secret Manager path — resolved once GCP credentials are supplied.
    throw new ValidationError(
      `Signing key ${ref} lives in Secret Manager, which is not configured yet.`,
    );
  }

  /** Recent entries for a unit, for the resident's "who came to my flat" view. */
  async recentForUnit(unitId: string, limit = 50) {
    return tx(async (db) =>
      db
        .select()
        .from(schema.gateEvents)
        .where(eq(schema.gateEvents.unitId, unitId))
        .orderBy(desc(schema.gateEvents.serverTs))
        .limit(Math.min(limit, 200)),
    );
  }

  /** Visitors still inside — an entry with no matching exit. Drives overstay alerts. */
  async stillInside() {
    return tx(async (db) =>
      db
        .select()
        .from(schema.gateEvents)
        .where(
          and(
            eq(schema.gateEvents.direction, "entry"),
            sql`NOT EXISTS (
              SELECT 1 FROM gate_events x
               WHERE x.exit_of_event_id = ${schema.gateEvents.id}
            )`,
          ),
        )
        .orderBy(desc(schema.gateEvents.serverTs))
        .limit(500),
    );
  }

  async getPass(passId: string) {
    return tx(async (db) => {
      const [pass] = await db
        .select()
        .from(schema.visitorPasses)
        .where(eq(schema.visitorPasses.id, passId))
        .limit(1);
      if (!pass) throw new NotFoundError("Pass not found.");
      return pass;
    });
  }

  async revokePass(passId: string): Promise<void> {
    await tx(async (db) => {
      await this.audit.record(db, {
        action: "pass.revoked",
        entityType: "visitor_pass",
        entityId: passId,
      });
      await db
        .update(schema.visitorPasses)
        .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.visitorPasses.id, passId));
    });
  }
}
