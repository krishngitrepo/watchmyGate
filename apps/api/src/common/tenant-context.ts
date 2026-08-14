/**
 * Per-request tenant scope.
 *
 * Every request that touches society data runs inside an AsyncLocalStorage context
 * carrying the caller's `societyId`. Handlers call `tx()` to get a database session
 * that is already scoped — they never choose a society themselves, so an endpoint
 * cannot accidentally read another society's rows by forgetting a filter.
 *
 * The database enforces this regardless (Row-Level Security with a NOBYPASSRLS role);
 * this layer exists so the correct thing is also the easy thing.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { withTenant, type TenantTx } from "@watchmygate/db";

export interface RequestContext {
  societyId: string;
  personId: string;
  roles: readonly string[];
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    // Reaching here means a handler ran outside the tenant middleware — a wiring bug,
    // and one that would otherwise surface as a silently unscoped query.
    throw new Error(
      "No request context. This code path must run inside the tenant middleware.",
    );
  }
  return ctx;
}

export function currentSocietyId(): string {
  return currentContext().societyId;
}

/**
 * Run a database operation scoped to the current request's society.
 *
 * @example
 * const rows = await tx(async (db) => db.select().from(schema.units));
 */
export function tx<T>(fn: (db: TenantTx) => Promise<T>): Promise<T> {
  const ctx = currentContext();
  return withTenant(ctx.societyId, fn, { actorId: ctx.personId });
}

export function hasRole(...roles: string[]): boolean {
  const held = new Set(currentContext().roles);
  return roles.some((r) => held.has(r));
}

/** Roles that see internal notes, all tickets, and society-wide financial data. */
export const STAFF_ROLES = [
  "society_admin",
  "mc_member",
  "accountant",
  "auditor",
  "staff",
] as const;

export function isStaff(): boolean {
  return hasRole(...STAFF_ROLES);
}
