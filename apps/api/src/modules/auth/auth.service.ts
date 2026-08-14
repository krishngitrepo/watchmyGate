/**
 * Phone-OTP authentication.
 *
 * Design notes worth keeping:
 *
 * - The code is never stored, only an Argon2 hash. A database disclosure therefore does
 *   not hand an attacker live login codes.
 * - Codes come from `crypto.randomInt`, never `Math.random`.
 * - Requesting an OTP behaves identically for known and unknown numbers. Diverging
 *   would turn the endpoint into a "does this person live here" oracle.
 * - Refresh tokens rotate on every use and reuse is detected: presenting a token that
 *   has already been exchanged means a copy leaked, so the whole session family is
 *   revoked rather than guessing which holder is legitimate.
 */

import { randomInt, randomBytes, createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";
import argon2 from "argon2";
import { and, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { parsePhoneNumberWithError } from "libphonenumber-js";

import { schema, withoutTenant } from "@watchmygate/db";

import { loadConfig } from "../../common/config.js";
import {
  AuthenticationError,
  RateLimitError,
  ValidationError,
} from "../../common/errors.js";
import { SmsService } from "../notify/sms.service.js";

const OTP_LENGTH = 6;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccessClaims {
  personId: string;
  societyId: string | null;
  roles: string[];
  sessionId: string;
}

@Injectable()
export class AuthService {
  private readonly config = loadConfig();
  private readonly secret = new TextEncoder().encode(loadConfig().JWT_SECRET);

  constructor(private readonly sms: SmsService) {}

  /**
   * Normalise to E.164, defaulting to India.
   *
   * Residents type numbers every possible way — with +91, with a leading zero, with
   * spaces. Normalising at the boundary means the rest of the system has exactly one
   * representation and a lookup cannot miss.
   */
  normalisePhone(input: string): string {
    try {
      const parsed = parsePhoneNumberWithError(input, "IN");
      if (!parsed.isValid()) {
        throw new ValidationError("That doesn't look like a valid phone number.");
      }
      return parsed.number;
    } catch {
      throw new ValidationError("That doesn't look like a valid phone number.");
    }
  }

  async requestOtp(phone: string, requestIp?: string): Promise<void> {
    const now = new Date();

    await withoutTenant("otp_request", async (db) => {
      const cooldownFrom = new Date(
        now.getTime() - this.config.OTP_RESEND_COOLDOWN_SECONDS * 1000,
      );

      const [recent] = await db
        .select({ id: schema.otpChallenges.id })
        .from(schema.otpChallenges)
        .where(
          and(
            eq(schema.otpChallenges.phone, phone),
            gt(schema.otpChallenges.createdAt, cooldownFrom),
            isNull(schema.otpChallenges.consumedAt),
          ),
        )
        .limit(1);

      if (recent) {
        throw new RateLimitError(
          `An OTP was already sent. Try again in ${this.config.OTP_RESEND_COOLDOWN_SECONDS} seconds.`,
        );
      }

      const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");

      await db.insert(schema.otpChallenges).values({
        phone,
        codeHash: await argon2.hash(code),
        expiresAt: new Date(now.getTime() + this.config.OTP_TTL_SECONDS * 1000),
        requestIp: requestIp ?? null,
      });

      await this.sms.sendOtp(phone, code);
    });
  }

  /**
   * Verify a code and return the person, creating them on first login.
   *
   * A society admin must still grant a role before the account can see anything —
   * verifying a phone number proves identity, not membership.
   */
  async verifyOtp(phone: string, code: string): Promise<{ personId: string }> {
    const now = new Date();

    return withoutTenant("otp_verify", async (db) => {
      const [challenge] = await db
        .select()
        .from(schema.otpChallenges)
        .where(
          and(
            eq(schema.otpChallenges.phone, phone),
            isNull(schema.otpChallenges.consumedAt),
            gt(schema.otpChallenges.expiresAt, now),
          ),
        )
        .orderBy(desc(schema.otpChallenges.createdAt))
        .limit(1)
        .for("update");

      if (!challenge) {
        throw new ValidationError("That code has expired. Request a new one.");
      }
      if (challenge.attempts >= this.config.OTP_MAX_ATTEMPTS) {
        throw new RateLimitError("Too many incorrect attempts. Request a new code.");
      }

      await db
        .update(schema.otpChallenges)
        .set({ attempts: challenge.attempts + 1 })
        .where(eq(schema.otpChallenges.id, challenge.id));

      if (!(await argon2.verify(challenge.codeHash, code))) {
        throw new ValidationError("Incorrect code.");
      }

      await db
        .update(schema.otpChallenges)
        .set({ consumedAt: now })
        .where(eq(schema.otpChallenges.id, challenge.id));

      // Invalidate any other outstanding challenges for this number.
      await db
        .update(schema.otpChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(schema.otpChallenges.phone, phone),
            isNull(schema.otpChallenges.consumedAt),
            ne(schema.otpChallenges.id, challenge.id),
          ),
        );

      const [existing] = await db
        .select()
        .from(schema.persons)
        .where(eq(schema.persons.phone, phone))
        .limit(1);

      if (existing) {
        if (existing.status === "deactivated") {
          throw new ValidationError("This account has been deactivated.");
        }
        return { personId: existing.id };
      }

      const [created] = await db
        .insert(schema.persons)
        .values({ phone })
        .returning({ id: schema.persons.id });

      if (!created) throw new ValidationError("Could not create the account.");
      return { personId: created.id };
    });
  }

  /** Active role codes for a person within one society. */
  async rolesFor(personId: string, societyId: string | null): Promise<string[]> {
    if (!societyId) return [];

    return withoutTenant("auth_role_lookup", async (db) => {
      const rows = await db
        .select({ code: schema.roles.code })
        .from(schema.roleAssignments)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
        .where(
          and(
            eq(schema.roleAssignments.personId, personId),
            eq(schema.roleAssignments.societyId, societyId),
            isNull(schema.roleAssignments.validTo),
          ),
        );
      return rows.map((r) => r.code);
    });
  }

  async createSession(
    personId: string,
    opts: {
      societyId?: string | null;
      roles?: string[];
      deviceId?: string;
      deviceLabel?: string;
      ip?: string;
    } = {},
  ): Promise<TokenPair> {
    const refreshToken = randomBytes(48).toString("base64url");

    const sessionId = await withoutTenant("session_create", async (db) => {
      const [session] = await db
        .insert(schema.sessions)
        .values({
          personId,
          refreshTokenHash: this.hashRefresh(refreshToken),
          deviceId: opts.deviceId ?? null,
          deviceLabel: opts.deviceLabel ?? null,
          ip: opts.ip ?? null,
          expiresAt: new Date(
            Date.now() + this.config.JWT_REFRESH_TTL_DAYS * 86_400_000,
          ),
        })
        .returning({ id: schema.sessions.id });

      if (!session) throw new AuthenticationError("Could not start a session.");
      return session.id;
    });

    const { accessToken, expiresIn } = await this.issueAccessToken({
      personId,
      sessionId,
      societyId: opts.societyId ?? null,
      roles: opts.roles ?? [],
    });

    return { accessToken, refreshToken, expiresIn };
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * Reuse of an already-rotated token means a copy leaked — the legitimate client and
   * an attacker both hold one — so the whole family is revoked rather than trying to
   * guess which is which.
   */
  async rotateSession(
    refreshToken: string,
    opts: { societyId?: string | null } = {},
  ): Promise<TokenPair> {
    const now = new Date();
    const presented = this.hashRefresh(refreshToken);
    const newToken = randomBytes(48).toString("base64url");

    const { personId, sessionId } = await withoutTenant(
      "session_rotate",
      async (db) => {
        const [record] = await db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.refreshTokenHash, presented))
          .limit(1)
          .for("update");

        if (!record) {
          throw new AuthenticationError("Session expired or invalid. Please sign in again.");
        }

        if (record.rotatedTo) {
          await db
            .update(schema.sessions)
            .set({ revokedAt: now })
            .where(
              and(
                eq(schema.sessions.personId, record.personId),
                isNull(schema.sessions.revokedAt),
              ),
            );
          throw new AuthenticationError("Session expired or invalid. Please sign in again.");
        }

        if (record.revokedAt || record.expiresAt <= now) {
          throw new AuthenticationError("Session expired or invalid. Please sign in again.");
        }

        const [next] = await db
          .insert(schema.sessions)
          .values({
            personId: record.personId,
            refreshTokenHash: this.hashRefresh(newToken),
            deviceId: record.deviceId,
            deviceLabel: record.deviceLabel,
            ip: record.ip,
            expiresAt: new Date(
              now.getTime() + this.config.JWT_REFRESH_TTL_DAYS * 86_400_000,
            ),
          })
          .returning({ id: schema.sessions.id });

        if (!next) throw new AuthenticationError("Could not refresh the session.");

        await db
          .update(schema.sessions)
          .set({ rotatedTo: next.id, revokedAt: now, lastUsedAt: now })
          .where(eq(schema.sessions.id, record.id));

        return { personId: record.personId, sessionId: next.id };
      },
    );

    const roles = await this.rolesFor(personId, opts.societyId ?? null);
    const { accessToken, expiresIn } = await this.issueAccessToken({
      personId,
      sessionId,
      societyId: opts.societyId ?? null,
      roles,
    });

    return { accessToken, refreshToken: newToken, expiresIn };
  }

  async revokeSession(refreshToken: string): Promise<void> {
    await withoutTenant("session_revoke", async (db) => {
      await db
        .update(schema.sessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.sessions.refreshTokenHash, this.hashRefresh(refreshToken)),
            isNull(schema.sessions.revokedAt),
          ),
        );
    });
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret);
      return {
        personId: payload.sub as string,
        societyId: (payload.soc as string | null) ?? null,
        roles: (payload.roles as string[] | undefined) ?? [],
        sessionId: payload.sid as string,
      };
    } catch {
      throw new AuthenticationError("Session expired or invalid. Please sign in again.");
    }
  }

  /** Societies this person belongs to — drives the society picker after login. */
  async memberships(
    personId: string,
  ): Promise<Array<{ societyId: string; societyName: string; roles: string[] }>> {
    return withoutTenant("membership_list", async (db) => {
      const rows = await db
        .select({
          societyId: schema.roleAssignments.societyId,
          societyName: schema.societies.name,
          code: schema.roles.code,
        })
        .from(schema.roleAssignments)
        .innerJoin(schema.roles, eq(schema.roles.id, schema.roleAssignments.roleId))
        .innerJoin(
          schema.societies,
          eq(schema.societies.id, schema.roleAssignments.societyId),
        )
        .where(
          and(
            eq(schema.roleAssignments.personId, personId),
            isNull(schema.roleAssignments.validTo),
          ),
        );

      const grouped = new Map<string, { societyName: string; roles: string[] }>();
      for (const row of rows) {
        const entry = grouped.get(row.societyId) ?? {
          societyName: row.societyName,
          roles: [],
        };
        entry.roles.push(row.code);
        grouped.set(row.societyId, entry);
      }

      return [...grouped.entries()].map(([societyId, v]) => ({ societyId, ...v }));
    });
  }

  // ------------------------------------------------------------- internals

  private async issueAccessToken(input: {
    personId: string;
    sessionId: string;
    societyId: string | null;
    roles: string[];
  }): Promise<{ accessToken: string; expiresIn: number }> {
    const ttlSeconds = this.config.JWT_ACCESS_TTL_MINUTES * 60;

    // Short-lived because the role claims go stale: a committee member removed today
    // keeps access until expiry. That is the accepted trade for not querying roles on
    // every request.
    const accessToken = await new SignJWT({
      soc: input.societyId,
      roles: input.roles,
      sid: input.sessionId,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(input.personId)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.secret);

    return { accessToken, expiresIn: ttlSeconds };
  }

  /** SHA-256 is right here: the token is already 256 bits of entropy, so this is a
   * lookup key rather than a password needing a slow KDF. */
  private hashRefresh(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
