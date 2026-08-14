/**
 * Public surface of the database package.
 *
 * Two ways in, on purpose:
 *
 *   import { schema } from "@watchmygate/db"   → schema.tickets, schema.invoices, …
 *   import { tickets } from "@watchmygate/db"  → the table directly
 *
 * Application code uses the namespace form. It keeps table names unambiguous at the
 * call site (`schema.receipts` cannot be confused with a local variable) and means a
 * new table is reachable without touching an import list.
 *
 * Note what is NOT exported: the connection pool. Every query must go through
 * `withTenant`, because that is what sets `app.society_id` and makes Row-Level Security
 * apply. A raw pool handle in application code would be an unscoped query waiting to
 * happen, so the type system does not offer one.
 */

export * as schema from "./schema.js";
export * from "./schema.js";
export {
  initDatabase,
  getDatabase,
  closeDatabase,
  withTenant,
  withoutTenant,
  withSystemTenant,
  type Database,
  type TenantTx,
} from "./tenant.js";
