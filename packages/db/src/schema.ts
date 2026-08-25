/**
 * Drizzle schema.
 *
 * Conventions that carry real weight:
 *
 * - Every tenant-scoped table has `societyId` and an RLS policy (see migrations).
 * - Money is `numeric(18, 4)`. The pg type parser returns it as a **string**, which
 *   `packages/money` converts to Decimal. A currency value never becomes a JS number.
 * - Timestamps are `timestamptz`, stored UTC.
 * - Soft delete is avoided; explicit status columns mean a query cannot forget a filter.
 */

import {
  boolean,
  char,
  date,
  index,
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ------------------------------------------------------------------- enums

export const societyStatus = pgEnum("society_status", [
  "onboarding",
  "active",
  "suspended",
]);
export const planTier = pgEnum("plan_tier", ["basic", "pro", "enterprise"]);
export const unitStatus = pgEnum("unit_status", [
  "occupied",
  "vacant",
  "under_renovation",
]);
export const occupancyRelationship = pgEnum("occupancy_relationship", [
  "owner",
  "tenant",
  "family_member",
  "occupant",
]);
export const personStatus = pgEnum("person_status", ["active", "deactivated"]);
export const roleCode = pgEnum("role_code", [
  "super_admin",
  "society_admin",
  "mc_member",
  "accountant",
  "auditor",
  "guard",
  "resident",
  "staff",
]);
export const roleScopeType = pgEnum("role_scope_type", ["society", "tower", "unit"]);

export const ticketStatus = pgEnum("ticket_status", [
  "open",
  "in_progress",
  "resolved",
  "closed",
  "reopened",
]);
export const ticketPriority = pgEnum("ticket_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);
export const ticketLocationType = pgEnum("ticket_location_type", [
  "unit",
  "tower",
  "floor",
  "amenity",
  "common",
]);
export const ticketEventType = pgEnum("ticket_event_type", [
  "comment",
  "status_change",
  "assignment",
  "internal_note",
  "attachment",
  "rating",
  "reopen",
  "escalation",
]);
export const visibility = pgEnum("ticket_event_visibility", ["public", "staff_only"]);
export const attachmentKind = pgEnum("attachment_kind", [
  "photo",
  "video",
  "voice",
  "document",
]);

export const visitorCategory = pgEnum("visitor_category", [
  "guest",
  "delivery",
  "cab",
  "courier",
  "service",
  "staff",
]);
export const passStatus = pgEnum("pass_status", ["active", "used", "expired", "revoked"]);
export const gateDirection = pgEnum("gate_direction", ["entry", "exit"]);
export const approvalState = pgEnum("approval_state", [
  "pending",
  "approved",
  "denied",
  "auto_approved",
  "timed_out",
  "escalated",
]);
export const approvalRung = pgEnum("approval_rung", [
  "push",
  "ivr",
  "sms",
  "standing_rule",
  "mc_escalation",
]);
export const standingAction = pgEnum("standing_action", [
  "auto_approve",
  "ask_to_wait",
  "deny",
]);
export const sosType = pgEnum("sos_type", ["medical", "fire", "gas", "security"]);

export const accountType = pgEnum("account_type", [
  "asset",
  "liability",
  "income",
  "expense",
  "equity",
]);
export const journalSourceType = pgEnum("journal_source_type", [
  "invoice",
  "receipt",
  "payment",
  "adjustment",
  "opening",
  "contra",
]);
export const periodStatus = pgEnum("period_status", ["open", "locked"]);
export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "issued",
  "partially_paid",
  "paid",
  "void",
]);
export const billingFormula = pgEnum("billing_formula", [
  "flat",
  "per_sqft",
  "per_bhk",
  "per_meter",
  "percentage",
  "manual",
]);
export const paymentMethod = pgEnum("payment_method", [
  "upi",
  "card",
  "netbanking",
  "neft",
  "cash",
  "cheque",
]);
export const payeeType = pgEnum("payee_type", ["society", "person"]);
export const destinationMode = pgEnum("destination_mode", [
  "route_linked",
  "direct_merchant",
]);
export const destinationStatus = pgEnum("destination_status", [
  "pending",
  "verified",
  "failed",
  "disabled",
]);

// --------------------------------------------------------- shared columns

const money = (name: string) => numeric(name, { precision: 18, scale: 4 });
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// ------------------------------------------------------------- tenancy

export const societies = pgTable("societies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  /** Drives the statutory rule-pack — billing heads and AGM rules differ by state. */
  stateCode: char("state_code", { length: 2 }).notNull(),
  planTier: planTier("plan_tier").notNull().default("basic"),
  timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Kolkata"),
  status: societyStatus("status").notNull().default("onboarding"),
  ...timestamps,
});

/**
 * Not tenant-scoped, deliberately: one human may be a resident in society A and a
 * committee member in society B. Scoping lives on the relationship, not the person.
 */
export const persons = pgTable("persons", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: varchar("phone", { length: 16 }).notNull().unique(),
  name: varchar("name", { length: 200 }),
  email: varchar("email", { length: 320 }),
  status: personStatus("status").notNull().default("active"),
  totpEnrolled: boolean("totp_enrolled").notNull().default(false),
  ...timestamps,
});

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: roleCode("code").notNull().unique(),
  name: varchar("name", { length: 80 }).notNull(),
});

export const towers = pgTable(
  "towers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    name: varchar("name", { length: 80 }).notNull(),
    floors: integer("floors"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_tower_society_name").on(t.societyId, t.name),
    index("ix_towers_society").on(t.societyId),
  ],
);

export const units = pgTable(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    towerId: uuid("tower_id")
      .notNull()
      .references(() => towers.id),
    number: varchar("number", { length: 32 }).notNull(),
    floor: integer("floor"),
    carpetAreaSqft: numeric("carpet_area_sqft", { precision: 10, scale: 2 }),
    bhk: integer("bhk"),
    status: unitStatus("status").notNull().default("vacant"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_unit_society_tower_number").on(t.societyId, t.towerId, t.number),
    index("ix_units_society_status").on(t.societyId, t.status),
  ],
);

/**
 * Bitemporal occupancy — the part competitors get wrong.
 *
 * Billing liability, voting rights and app access are three *separate* relationships
 * and routinely belong to different people: the owner votes while the tenant pays, and
 * both need access.
 *
 * `validFrom`/`validTo` is business time; `recordedAt` is system time. A resident
 * saying six weeks later "I actually moved out on the 3rd" inserts a correction rather
 * than editing history, so bills regenerate correctly while the audit trail keeps what
 * we believed and when.
 */
export const unitOccupancies = pgTable(
  "unit_occupancies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    relationship: occupancyRelationship("relationship").notNull(),
    isBillingLiable: boolean("is_billing_liable").notNull().default(false),
    hasVotingRight: boolean("has_voting_right").notNull().default(false),
    hasAppAccess: boolean("has_app_access").notNull().default(true),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [
    index("ix_occupancy_person").on(t.societyId, t.personId),
    index("ix_occupancy_unit").on(t.societyId, t.unitId),
  ],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id),
    scopeType: roleScopeType("scope_type").notNull().default("society"),
    scopeId: uuid("scope_id"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    ...timestamps,
  },
  (t) => [index("ix_role_assignment_person").on(t.personId, t.societyId)],
);

// ---------------------------------------------------------------- auth

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: varchar("phone", { length: 16 }).notNull(),
    /** Argon2 hash. The code itself is never stored. */
    codeHash: varchar("code_hash", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    requestIp: inet("request_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_otp_phone_active").on(t.phone, t.expiresAt)],
);

/**
 * Refresh tokens rotate on every use. `rotatedTo` detects reuse of an already-exchanged
 * token — which means a copy leaked, so the whole session family is revoked rather than
 * guessing which holder is legitimate.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    refreshTokenHash: varchar("refresh_token_hash", { length: 255 }).notNull().unique(),
    /** Guard devices are society property; an admin must be able to revoke one handset. */
    deviceId: varchar("device_id", { length: 128 }),
    deviceLabel: varchar("device_label", { length: 128 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedTo: uuid("rotated_to"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    ip: inet("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_session_person").on(t.personId)],
);

// ------------------------------------------------------------ helpdesk

export const ticketCategories = pgTable(
  "ticket_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    parentId: uuid("parent_id"),
    name: varchar("name", { length: 120 }).notNull(),
    /** Auto-routing target. Assignee wins if both are set. */
    defaultAssigneeId: uuid("default_assignee_id"),
    defaultVendorId: uuid("default_vendor_id"),
    slaHours: integer("sla_hours").notNull().default(24),
    escalationHours: integer("escalation_hours").notNull().default(48),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("ix_category_society").on(t.societyId)],
);

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    /** Human-facing, per society. Residents quote it on the phone. */
    ticketNumber: varchar("ticket_number", { length: 24 }).notNull(),
    raisedBy: uuid("raised_by")
      .notNull()
      .references(() => persons.id),
    /** Null for common-area issues — the lift belongs to the tower, not a flat. */
    unitId: uuid("unit_id").references(() => units.id),
    locationType: ticketLocationType("location_type").notNull(),
    locationRef: uuid("location_ref"),
    locationNote: varchar("location_note", { length: 200 }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => ticketCategories.id),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    /** Set when filed by voice, so the original language is preserved. */
    voiceTranscriptLanguage: varchar("voice_transcript_language", { length: 8 }),
    status: ticketStatus("status").notNull().default("open"),
    priority: ticketPriority("priority").notNull().default("normal"),
    assigneeId: uuid("assignee_id"),
    vendorId: uuid("vendor_id"),
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(),
    escalationDueAt: timestamp("escalation_due_at", { withTimezone: true }).notNull(),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    rating: integer("rating"),
    ratingComment: varchar("rating_comment", { length: 500 }),
    /** Set when merged into an earlier report of the same problem. */
    duplicateOf: uuid("duplicate_of"),
    reopenCount: integer("reopen_count").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_ticket_society_number").on(t.societyId, t.ticketNumber),
    index("ix_ticket_society_status").on(t.societyId, t.status),
    index("ix_ticket_sla_due").on(t.societyId, t.slaDueAt),
    index("ix_ticket_raised_by").on(t.societyId, t.raisedBy),
  ],
);

export const ticketEvents = pgTable(
  "ticket_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id"),
    type: ticketEventType("type").notNull(),
    body: text("body"),
    /** staff_only notes are never returned to the resident who raised the ticket. */
    visibility: visibility("visibility").notNull().default("public"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_ticket_event_ticket").on(t.societyId, t.ticketId, t.createdAt)],
);

/** Everyone notified — reporter, assignee, committee, and reporters of merged duplicates. */
export const ticketSubscribers = pgTable(
  "ticket_subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    reason: varchar("reason", { length: 40 }).notNull().default("reporter"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_ticket_subscriber").on(t.ticketId, t.personId)],
);

/** A file in R2. The row records the key; bytes never pass through the API. */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    ownerType: varchar("owner_type", { length: 32 }).notNull(),
    ownerId: uuid("owner_id").notNull(),
    r2Key: varchar("r2_key", { length: 500 }).notNull().unique(),
    contentType: varchar("content_type", { length: 120 }).notNull(),
    bytes: integer("bytes").notNull(),
    kind: attachmentKind("kind").notNull(),
    uploadedBy: uuid("uploaded_by"),
    /** Distinguishes the repair evidence from the resident's original photos. */
    isProofOfFix: boolean("is_proof_of_fix").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_attachment_owner").on(t.societyId, t.ownerType, t.ownerId)],
);

// ---------------------------------------------------------------- gate

export const societySigningKeys = pgTable(
  "society_signing_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    keyVersion: integer("key_version").notNull(),
    publicKey: varchar("public_key", { length: 120 }).notNull(),
    /** Reference to Secret Manager. The private key is never stored here. */
    privateKeyRef: varchar("private_key_ref", { length: 300 }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_signing_key_version").on(t.societyId, t.keyVersion)],
);

export const gates = pgTable(
  "gates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    name: varchar("name", { length: 80 }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_gate_society_name").on(t.societyId, t.name)],
);

export const visitorPasses = pgTable(
  "visitor_passes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => persons.id),
    visitorName: varchar("visitor_name", { length: 120 }).notNull(),
    visitorPhone: varchar("visitor_phone", { length: 16 }),
    /** Salted and non-reversible — the QR is photographed and forwarded on WhatsApp. */
    visitorHash: varchar("visitor_hash", { length: 64 }).notNull(),
    visitorSalt: varchar("visitor_salt", { length: 32 }).notNull(),
    category: visitorCategory("category").notNull(),
    vehicleNumber: varchar("vehicle_number", { length: 20 }),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: timestamp("valid_to", { withTimezone: true }).notNull(),
    maxUses: integer("max_uses").notNull().default(1),
    uses: integer("uses").notNull().default(0),
    keyVersion: integer("key_version").notNull(),
    qrValue: text("qr_value").notNull(),
    status: passStatus("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("ix_pass_unit").on(t.societyId, t.unitId)],
);

/**
 * Append-only and conflict-free by construction.
 *
 * The id is a client-generated UUIDv7, so the guard app creates events offline and
 * replays them idempotently — the primary key *is* the deduplication key.
 */
export const gateEvents = pgTable(
  "gate_events",
  {
    id: uuid("id").primaryKey(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    gateId: uuid("gate_id"),
    unitId: uuid("unit_id"),
    passId: uuid("pass_id"),
    guardPersonId: uuid("guard_person_id"),
    direction: gateDirection("direction").notNull(),
    category: visitorCategory("category").notNull(),
    visitorName: varchar("visitor_name", { length: 120 }),
    visitorPhone: varchar("visitor_phone", { length: 16 }),
    vehicleNumber: varchar("vehicle_number", { length: 20 }),
    photoKey: varchar("photo_key", { length: 500 }),
    /** True when the guard app verified the pass signature with no network. */
    verifiedOffline: boolean("verified_offline").notNull().default(false),
    /** Guard clocks are routinely hours out. Business logic uses serverTs only. */
    deviceTs: timestamp("device_ts", { withTimezone: true }).notNull(),
    serverTs: timestamp("server_ts", { withTimezone: true }).notNull().defaultNow(),
    clockDriftSeconds: integer("clock_drift_seconds"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    approvalId: uuid("approval_id"),
    exitOfEventId: uuid("exit_of_event_id"),
    overstayAlertedAt: timestamp("overstay_alerted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ix_gate_event_unit").on(t.societyId, t.unitId, t.serverTs),
    index("ix_gate_event_recent").on(t.societyId, t.serverTs),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id").notNull(),
    gateEventId: uuid("gate_event_id"),
    state: approvalState("state").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by"),
    resolutionRung: approvalRung("resolution_rung"),
    visitorName: varchar("visitor_name", { length: 120 }),
    visitorPhone: varchar("visitor_phone", { length: 16 }),
    category: visitorCategory("category").notNull(),
    photoKey: varchar("photo_key", { length: 500 }),
    standingRuleId: uuid("standing_rule_id"),
    ...timestamps,
  },
  (t) => [index("ix_approval_pending").on(t.societyId, t.state, t.requestedAt)],
);

/** One row per ladder step fired — lets a resident check "I never got the notification". */
export const approvalRungs = pgTable(
  "approval_rungs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvals.id, { onDelete: "cascade" }),
    rung: approvalRung("rung").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
    channelResult: varchar("channel_result", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_rung_approval").on(t.societyId, t.approvalId)],
);

/** Per-unit default applied at t=45s: "always let Amazon in", "never salespeople". */
export const standingRules = pgTable(
  "standing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id").notNull(),
    category: visitorCategory("category"),
    matcher: varchar("matcher", { length: 120 }),
    action: standingAction("action").notNull(),
    createdBy: uuid("created_by"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("ix_standing_rule_unit").on(t.societyId, t.unitId)],
);

export const sosAlerts = pgTable(
  "sos_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    personId: uuid("person_id").notNull(),
    unitId: uuid("unit_id"),
    type: sosType("type").notNull(),
    latitude: varchar("latitude", { length: 24 }),
    longitude: varchar("longitude", { length: 24 }),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull(),
    acknowledgedBy: uuid("acknowledged_by"),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("ix_sos_open").on(t.societyId, t.closedAt)],
);

export const watchlist = pgTable(
  "watchlist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    phone: varchar("phone", { length: 16 }).notNull(),
    name: varchar("name", { length: 120 }),
    reason: varchar("reason", { length: 300 }).notNull(),
    addedBy: uuid("added_by"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_watchlist_society_phone").on(t.societyId, t.phone)],
);

// -------------------------------------------------------------- ledger

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    code: varchar("code", { length: 24 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    type: accountType("type").notNull(),
    parentId: uuid("parent_id"),
    /** Corpus and sinking funds — spending needs committee approval. */
    isRestricted: boolean("is_restricted").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_account_society_code").on(t.societyId, t.code)],
);

export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    status: periodStatus("status").notNull().default("open"),
    lockedBy: uuid("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    /** Two-person control: reopening a closed book is how fraud happens. */
    reopenedBy: uuid("reopened_by"),
    reopenedApprovedBy: uuid("reopened_approved_by"),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_period_society_start").on(t.societyId, t.startsOn)],
);

/**
 * Posted entries are immutable. UPDATE and DELETE are revoked from the application role
 * and enforced by trigger in migration 0002 — application discipline is not the control.
 * Corrections are reversing entries.
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    entryNumber: varchar("entry_number", { length: 24 }).notNull(),
    entryDate: date("entry_date").notNull(),
    narration: text("narration").notNull(),
    sourceType: journalSourceType("source_type").notNull(),
    sourceId: uuid("source_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    postedBy: uuid("posted_by"),
    reversesEntryId: uuid("reverses_entry_id"),
    periodId: uuid("period_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_journal_society_number").on(t.societyId, t.entryNumber),
    index("ix_journal_date").on(t.societyId, t.entryDate),
    index("ix_journal_source").on(t.societyId, t.sourceType, t.sourceId),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    journalEntryId: uuid("journal_entry_id")
      .notNull()
      .references(() => journalEntries.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    debit: money("debit").notNull().default("0"),
    credit: money("credit").notNull().default("0"),
    currency: char("currency", { length: 3 }).notNull().default("INR"),
    unitId: uuid("unit_id"),
  },
  (t) => [
    index("ix_line_entry").on(t.journalEntryId),
    index("ix_line_account").on(t.societyId, t.accountId),
  ],
);

// -------------------------------------------------------------- billing

export const chargeTypes = pgTable(
  "charge_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    formula: billingFormula("formula").notNull(),
    rate: money("rate").notNull().default("0"),
    accountId: uuid("account_id").notNull(),
    gstApplicable: boolean("gst_applicable").notNull().default(false),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull().default("18"),
    isRecurring: boolean("is_recurring").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_charge_society_code").on(t.societyId, t.code)],
);

/** Statutory thresholds as data, not code — legislation moves. */
export const gstRules = pgTable("gst_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id")
    .notNull()
    .references(() => societies.id),
  effectiveFrom: date("effective_from").notNull(),
  monthlyThresholdPerMember: money("monthly_threshold_per_member").notNull().default("7500"),
  annualTurnoverThreshold: money("annual_turnover_threshold").notNull().default("2000000"),
  rate: numeric("rate", { precision: 5, scale: 2 }).notNull().default("18"),
  societyTurnover: money("society_turnover").notNull().default("0"),
  lateFeePercentPerMonth: numeric("late_fee_percent_per_month", {
    precision: 5,
    scale: 2,
  })
    .notNull()
    .default("0"),
  graceDays: integer("grace_days").notNull().default(0),
  ...timestamps,
});

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id").notNull(),
    invoiceNumber: varchar("invoice_number", { length: 32 }).notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    subtotal: money("subtotal").notNull().default("0"),
    gstAmount: money("gst_amount").notNull().default("0"),
    lateFee: money("late_fee").notNull().default("0"),
    total: money("total").notNull().default("0"),
    currency: char("currency", { length: 3 }).notNull().default("INR"),
    status: invoiceStatus("status").notNull().default("draft"),
    /** Frozen at issue time — if the tenant moves out next week this invoice is still theirs. */
    liablePersonId: uuid("liable_person_id"),
    journalEntryId: uuid("journal_entry_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_invoice_society_number").on(t.societyId, t.invoiceNumber),
    index("ix_invoice_unit_status").on(t.societyId, t.unitId, t.status),
    index("ix_invoice_due").on(t.societyId, t.dueDate),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    chargeTypeId: uuid("charge_type_id").notNull(),
    description: varchar("description", { length: 300 }).notNull(),
    quantity: money("quantity").notNull().default("1"),
    rate: money("rate").notNull().default("0"),
    amount: money("amount").notNull().default("0"),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull().default("0"),
    gstAmount: money("gst_amount").notNull().default("0"),
  },
  (t) => [index("ix_invoice_line_invoice").on(t.invoiceId)],
);

// ------------------------------------------------------------- payments

/**
 * Where money for a charge goes.
 *
 * `route_linked` — Razorpay Route, settling to the society's own bank.
 * `direct_merchant` — the owner's own gateway account, zero platform commission.
 *
 * In both, funds never enter a WatchMyGate account. Credentials are **references to
 * Secret Manager paths**, never the secrets themselves.
 */
export const paymentDestinations = pgTable(
  "payment_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    payeeType: payeeType("payee_type").notNull(),
    payeeId: uuid("payee_id").notNull(),
    mode: destinationMode("mode").notNull(),
    provider: varchar("provider", { length: 32 }).notNull().default("razorpay"),
    merchantId: varchar("merchant_id", { length: 120 }),
    credentialsSecretRef: varchar("credentials_secret_ref", { length: 300 }),
    webhookSecretRef: varchar("webhook_secret_ref", { length: 300 }),
    status: destinationStatus("status").notNull().default("pending"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Razorpay Smart Collect per-unit virtual account, for NEFT auto-reconciliation. */
    virtualAccountNumber: varchar("virtual_account_number", { length: 64 }),
    virtualIfsc: varchar("virtual_ifsc", { length: 16 }),
    ...timestamps,
  },
  (t) => [index("ix_destination_payee").on(t.societyId, t.payeeType, t.payeeId)],
);

export const chargeTypeRouting = pgTable(
  "charge_type_routing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    chargeTypeCode: varchar("charge_type_code", { length: 32 }).notNull(),
    unitId: uuid("unit_id"),
    destinationId: uuid("destination_id").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_routing").on(t.societyId, t.chargeTypeCode, t.unitId)],
);

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id"),
    receiptNumber: varchar("receipt_number", { length: 32 }).notNull(),
    receivedOn: date("received_on").notNull(),
    amount: money("amount").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("INR"),
    method: paymentMethod("method").notNull(),
    providerPaymentId: varchar("provider_payment_id", { length: 120 }),
    /** Webhook idempotency — Razorpay retries aggressively, so a conflict is correct. */
    providerEventId: varchar("provider_event_id", { length: 160 }).unique(),
    destinationId: uuid("destination_id"),
    journalEntryId: uuid("journal_entry_id"),
    payerPersonId: uuid("payer_person_id"),
    /** Manual UTR entry. Never marks an invoice paid on its own. */
    unverifiedUtr: varchar("unverified_utr", { length: 40 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uq_receipt_society_number").on(t.societyId, t.receiptNumber),
    index("ix_receipt_unit").on(t.societyId, t.unitId),
  ],
);

export const receiptAllocations = pgTable(
  "receipt_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    amount: money("amount").notNull(),
  },
  (t) => [
    index("ix_allocation_receipt").on(t.receiptId),
    index("ix_allocation_invoice").on(t.invoiceId),
  ],
);

// ---------------------------------------------------------------- audit

export const auditLog = pgTable("audit_log", {
  id: uuid("id").notNull().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  societyId: uuid("society_id"),
  actorPersonId: uuid("actor_person_id"),
  action: varchar("action", { length: 80 }).notNull(),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: uuid("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  /** Required for sensitive reads — credential access, CCTV, attachment downloads. */
  reason: varchar("reason", { length: 500 }),
  ip: inet("ip"),
  userAgent: varchar("user_agent", { length: 400 }),
});

/** Consent ledger — append-only. Withdrawal is a new row, never an update. */
export const consents = pgTable("consents", {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id"),
  personId: uuid("person_id")
    .notNull()
    .references(() => persons.id),
  purpose: varchar("purpose", { length: 120 }).notNull(),
  noticeVersion: varchar("notice_version", { length: 32 }).notNull(),
  noticeTextHash: varchar("notice_text_hash", { length: 64 }).notNull(),
  granted: boolean("granted").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  source: varchar("source", { length: 16 }).notNull().default("app"),
  ip: inet("ip"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Push notification device registrations. */
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 400 }).notNull().unique(),
    platform: varchar("platform", { length: 16 }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_device_person").on(t.personId)],
);

// ------------------------------------------------------------ amenities

export const amenities = pgTable(
  "amenities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    name: varchar("name", { length: 120 }).notNull(),
    capacity: integer("capacity"),
    slotMinutes: integer("slot_minutes").notNull().default(60),
    isPaid: boolean("is_paid").notNull().default(false),
    rate: money("rate").notNull().default("0"),
    rules: jsonb("rules"),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_amenity_society_name").on(t.societyId, t.name)],
);

/**
 * Booking conflicts are prevented by an `EXCLUDE USING gist` constraint in migration
 * 0002, which Drizzle cannot express — so it lives in SQL and is verified by test
 * rather than declared here.
 *
 * That constraint is the whole point: an application-level "is this slot free?" check
 * races under concurrency and eventually double-books the party hall on a Saturday.
 */
export const amenityBookings = pgTable(
  "amenity_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    amenityId: uuid("amenity_id")
      .notNull()
      .references(() => amenities.id),
    unitId: uuid("unit_id").notNull(),
    bookedBy: uuid("booked_by").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("confirmed"),
    invoiceId: uuid("invoice_id"),
    ...timestamps,
  },
  (t) => [index("ix_booking_amenity").on(t.societyId, t.amenityId, t.startsAt)],
);

// ==========================================================================
// Phase 2 — staff, deliveries, notices, vehicles, parking
// Tables in migration 0007, controls in 0008.
// ==========================================================================

export const staffKind = pgEnum("staff_kind", [
  "maid",
  "cook",
  "nanny",
  "driver",
  "gardener",
  "security",
  "vendor_staff",
  "other",
]);
export const staffStatus = pgEnum("staff_status", [
  "pending",
  "active",
  "suspended",
  "exited",
]);
export const verificationStatus = pgEnum("verification_status", [
  "not_started",
  "submitted",
  "verified",
  "rejected",
  "expired",
]);
export const attendanceMethod = pgEnum("attendance_method", [
  "gate_scan",
  "pin",
  "card",
  "manual",
  "biometric",
]);
export const deliveryStatus = pgEnum("delivery_status", [
  "at_gate",
  "awaiting_resident",
  "held_at_gate",
  "out_for_doorstep",
  "delivered",
  "collected",
  "returned",
  "refused",
]);
export const noticeKind = pgEnum("notice_kind", [
  "circular",
  "event",
  "poll",
  "emergency",
]);
export const noticeAudience = pgEnum("notice_audience", [
  "society",
  "tower",
  "owners",
  "tenants",
  "committee",
  "custom",
]);
export const dltCategory = pgEnum("dlt_category", [
  "transactional",
  "service_explicit",
  "service_implicit",
  "promotional",
]);
export const vehicleKind = pgEnum("vehicle_kind", [
  "car",
  "two_wheeler",
  "bicycle",
  "commercial",
  "other",
]);
export const parkingKind = pgEnum("parking_kind", [
  "covered",
  "open",
  "stack",
  "visitor",
  "accessible",
  "ev",
]);

/**
 * Staff.
 *
 * There is deliberately no column that could hold an Aadhaar number — only the
 * verification outcome and a masked last-4. Aadhaar Act §57 was struck down, so a
 * private entity cannot mandate Aadhaar authentication.
 */
export const staff = pgTable(
  "staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    personId: uuid("person_id"),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    phone: varchar("phone", { length: 16 }).notNull(),
    kind: staffKind("kind").notNull(),
    status: staffStatus("status").notNull().default("pending"),
    photoKey: varchar("photo_key", { length: 400 }),
    employerUnitId: uuid("employer_unit_id"),
    vendorName: varchar("vendor_name", { length: 160 }),
    verification: verificationStatus("verification").notNull().default("not_started"),
    verificationRef: varchar("verification_ref", { length: 120 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    idLast4: varchar("id_last4", { length: 4 }),
    policeVerifiedAt: timestamp("police_verified_at", { withTimezone: true }),
    gatePinHash: varchar("gate_pin_hash", { length: 200 }),
    dailyStart: time("daily_start"),
    dailyEnd: time("daily_end"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("ix_staff_society").on(t.societyId, t.status),
    index("ix_staff_phone").on(t.societyId, t.phone),
    index("ix_staff_employer").on(t.societyId, t.employerUnitId),
  ],
);

/** A maid working six flats is the normal case, not the exception. */
export const staffAssignments = pgTable(
  "staff_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull(),
    startedOn: date("started_on").notNull().defaultNow(),
    endedOn: date("ended_on"),
    monthlyRate: numeric("monthly_rate", { precision: 18, scale: 4 }),
    ...timestamps,
  },
  (t) => [index("ix_assignment_unit").on(t.societyId, t.unitId)],
);

/**
 * Attendance — a wage record, so it can never be deleted (trigger in 0008).
 * Timestamps are server-assigned; a gate handset's clock is routinely hours out.
 */
export const staffAttendance = pgTable(
  "staff_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staff.id, { onDelete: "cascade" }),
    gateId: uuid("gate_id"),
    workDate: date("work_date").notNull(),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull(),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    method: attendanceMethod("method").notNull(),
    overriddenBy: uuid("overridden_by"),
    overrideNote: text("override_note"),
    ...timestamps,
  },
  (t) => [index("ix_attendance_day").on(t.societyId, t.workDate)],
);

/** Gate-to-doorstep, with the handover proof that makes "delivered" more than a claim. */
export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id"),
    gateEventId: uuid("gate_event_id"),
    courier: varchar("courier", { length: 120 }).notNull(),
    trackingRef: varchar("tracking_ref", { length: 120 }),
    parcelCount: integer("parcel_count").notNull().default(1),
    status: deliveryStatus("status").notNull().default("at_gate"),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }).notNull().defaultNow(),
    heldAtGateAt: timestamp("held_at_gate_at", { withTimezone: true }),
    handoverAt: timestamp("handover_at", { withTimezone: true }),
    handoverTo: varchar("handover_to", { length: 160 }),
    handoverPhotoKey: varchar("handover_photo_key", { length: 400 }),
    handoverBy: uuid("handover_by"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("ix_delivery_unit").on(t.societyId, t.unitId, t.status),
    index("ix_delivery_open").on(t.societyId, t.status, t.arrivedAt),
  ],
);

export const notices = pgTable(
  "notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    kind: noticeKind("kind").notNull().default("circular"),
    title: varchar("title", { length: 200 }).notNull(),
    body: text("body").notNull(),
    audience: noticeAudience("audience").notNull().default("society"),
    audienceRef: jsonb("audience_ref"),
    isPinned: boolean("is_pinned").notNull().default(false),
    publishAt: timestamp("publish_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    eventAt: timestamp("event_at", { withTimezone: true }),
    eventPlace: varchar("event_place", { length: 200 }),
    createdBy: uuid("created_by").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("ix_notice_feed").on(t.societyId, t.publishAt)],
);

/** "Did anyone actually read the circular" is a committee's first question. */
export const noticeReads = pgTable("notice_reads", {
  noticeId: uuid("notice_id")
    .notNull()
    .references(() => notices.id, { onDelete: "cascade" }),
  personId: uuid("person_id").notNull(),
  societyId: uuid("society_id")
    .notNull()
    .references(() => societies.id),
  readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pollOptions = pgTable(
  "poll_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    noticeId: uuid("notice_id")
      .notNull()
      .references(() => notices.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 200 }).notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("ix_poll_option_notice").on(t.noticeId, t.position)],
);

/** One vote per person, enforced by the primary key rather than by application care. */
export const pollVotes = pgTable(
  "poll_votes",
  {
    noticeId: uuid("notice_id")
      .notNull()
      .references(() => notices.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    optionId: uuid("option_id")
      .notNull()
      .references(() => pollOptions.id, { onDelete: "cascade" }),
    votedAt: timestamp("voted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_poll_vote_option").on(t.optionId)],
);

/**
 * DLT template registry.
 *
 * The registered category decides whether a message may reach a DND number, so it is a
 * row here rather than a constant in the sending code — that is what lets the notify
 * service refuse a promotional send without a human remembering to.
 *
 * `societyId` NULL means a platform-wide template available to every society.
 */
export const dltTemplates = pgTable("dlt_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").references(() => societies.id),
  code: varchar("code", { length: 80 }).notNull(),
  providerId: varchar("provider_id", { length: 120 }).notNull(),
  header: varchar("header", { length: 20 }).notNull(),
  category: dltCategory("category").notNull(),
  body: text("body").notNull(),
  variables: jsonb("variables"),
  isActive: boolean("is_active").notNull().default(true),
  registeredAt: timestamp("registered_at", { withTimezone: true }),
  ...timestamps,
});

/**
 * Vehicles.
 *
 * `plate` is normalised (uppercase, alphanumeric only) and `plateDisplay` keeps what a
 * human typed. The same car is written three ways by three guards, and a lookup that
 * misses is a resident stopped at their own gate.
 */
export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    unitId: uuid("unit_id"),
    staffId: uuid("staff_id").references(() => staff.id, { onDelete: "set null" }),
    plate: varchar("plate", { length: 16 }).notNull(),
    plateDisplay: varchar("plate_display", { length: 24 }).notNull(),
    kind: vehicleKind("kind").notNull().default("car"),
    makeModel: varchar("make_model", { length: 120 }),
    colour: varchar("colour", { length: 40 }),
    stickerNo: varchar("sticker_no", { length: 40 }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("ix_vehicle_unit").on(t.societyId, t.unitId)],
);

/** Allotment lives on the slot, so two rows can never claim the same space. */
export const parkingSlots = pgTable(
  "parking_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    code: varchar("code", { length: 40 }).notNull(),
    kind: parkingKind("kind").notNull().default("open"),
    towerId: uuid("tower_id"),
    level: varchar("level", { length: 20 }),
    unitId: uuid("unit_id"),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    allottedAt: timestamp("allotted_at", { withTimezone: true }),
    monthlyRate: numeric("monthly_rate", { precision: 18, scale: 4 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [uniqueIndex("uq_slot_code").on(t.societyId, t.code)],
);

export const parkingViolations = pgTable(
  "parking_violations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    slotId: uuid("slot_id").references(() => parkingSlots.id, { onDelete: "set null" }),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id, { onDelete: "set null" }),
    plate: varchar("plate", { length: 16 }).notNull(),
    reason: varchar("reason", { length: 120 }).notNull(),
    photoKey: varchar("photo_key", { length: 400 }),
    reportedBy: uuid("reported_by"),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("ix_violation_open").on(t.societyId, t.resolvedAt)],
);

// ==========================================================================
// DPDP Act 2023 / Rules 2025 — tables in migration 0009, controls in the same file.
//
// Full substantive compliance is due 13 May 2027 with penalties to Rs 250 crore, so
// this is dated work rather than a backlog item.
//
// The controls that matter are not expressible in Drizzle and live in the SQL: consents
// and the CCTV log are append-only by trigger, and notice text is immutable. See
// 0009_dpdp.sql — a control that only holds while the calling code is correct is not a
// control.
// ==========================================================================

/**
 * The exact words a person agreed to.
 *
 * Without this, "they consented to v3" is unfalsifiable — and a society that quietly
 * edits v3 has rewritten what every resident agreed to. `consents.noticeTextHash` must
 * match `bodyHash`, which ties a consent to words rather than to a version label.
 */
export const consentNotices = pgTable("consent_notices", {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").references(() => societies.id),
  purpose: varchar("purpose", { length: 120 }).notNull(),
  version: varchar("version", { length: 32 }).notNull(),
  /** DPDP requires notice in English or an Eighth Schedule language, at the person's option. */
  language: varchar("language", { length: 8 }).notNull().default("en"),
  body: text("body").notNull(),
  bodyHash: varchar("body_hash", { length: 64 }).notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The right to erasure, as a request with an outcome.
 *
 * Not an immediate delete, because the honest answer to "erase everything about me" is
 * never simply yes: financial records are retained under statutory exemption, and so are
 * audit entries and gate events involving other people. The request records what went,
 * what stayed, and why — a workflow promising total erasure while quietly keeping the
 * ledger would be worse than one that says plainly what it keeps.
 */
export const erasureRequests = pgTable(
  "erasure_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id").references(() => societies.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    requestedBy: uuid("requested_by").references(() => persons.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    status: varchar("status", { length: 16 }).notNull().default("received"),
    dueBy: timestamp("due_by", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedBy: uuid("completed_by").references(() => persons.id),
    erased: jsonb("erased"),
    retained: jsonb("retained"),
    retentionBasis: text("retention_basis"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ix_erasure_person").on(t.personId, t.requestedAt),
    index("ix_erasure_due").on(t.status, t.dueBy),
  ],
);

/**
 * Who looked at footage, and why.
 *
 * The usual failure here is not a breach — it is a committee member idly watching who
 * visits whom. Every access carries a stated reason of at least ten characters, checked
 * by the database, and the log cannot be altered or deleted.
 */
export const cctvAccessLog = pgTable(
  "cctv_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    personId: uuid("person_id")
      .notNull()
      .references(() => persons.id),
    cameraRef: varchar("camera_ref", { length: 120 }).notNull(),
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_cctv_society").on(t.societyId, t.accessedAt)],
);

/** Purpose limitation with a number attached. Defaults live in the API. */
export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    subject: varchar("subject", { length: 40 }).notNull(),
    days: integer("days").notNull(),
    reason: text("reason"),
    updatedBy: uuid("updated_by").references(() => persons.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_retention_subject").on(t.societyId, t.subject)],
);

/** Every purge that ran. A retention policy nobody runs is a lie with a number in it. */
export const retentionRuns = pgTable(
  "retention_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id").references(() => societies.id),
    subject: varchar("subject", { length: 40 }).notNull(),
    cutoff: timestamp("cutoff", { withTimezone: true }).notNull(),
    rowsRemoved: integer("rows_removed").notNull().default(0),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ix_retention_run").on(t.societyId, t.ranAt)],
);

/**
 * The document repository — MG-30, and rental agreements (MG-32) as a category of it.
 *
 * Every society keeps the same shelf of paper: bye-laws, registration certificate, AGM
 * minutes, audited accounts, insurance, AMC contracts. Today it lives in one secretary's
 * WhatsApp and leaves with them when the committee turns over — that is the problem
 * being solved, not storage.
 *
 * Built on the existing attachment machinery: bytes go to R2 by presigned URL and never
 * through the API. Controls in migration 0010.
 */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    title: varchar("title", { length: 200 }).notNull(),
    category: varchar("category", { length: 40 }).notNull(),
    description: text("description"),

    /** Null while a document is recorded as existing but not yet scanned. */
    r2Key: varchar("r2_key", { length: 500 }),
    contentType: varchar("content_type", { length: 120 }),
    bytes: integer("bytes"),

    /**
     * `society` | `committee` | `unit`.
     *
     * An AGM minute is for everyone; a vendor contract with rates in it is committee
     * only; a rental agreement belongs to one flat. Without the distinction a secretary
     * keeps the sensitive half on WhatsApp exactly as before.
     */
    visibility: varchar("visibility", { length: 16 }).notNull().default("society"),
    unitId: uuid("unit_id"),

    /** Versioning by supersession. An audited account that can be swapped is not one. */
    version: integer("version").notNull().default(1),
    supersedesId: uuid("supersedes_id"),

    effectiveFrom: date("effective_from"),
    /** An insurance policy that lapsed in March is worse than none — everyone believes
     * there is cover. The console counts down against this. */
    expiresOn: date("expires_on"),

    uploadedBy: uuid("uploaded_by"),
    ...timestamps,
  },
  (t) => [
    index("ix_document_society").on(t.societyId, t.category),
    index("ix_document_unit").on(t.societyId, t.unitId),
  ],
);

// ----------------------------------------------------------------- budgets

/**
 * The annual budget a society passes at its AGM, head by head (MG-6).
 *
 * Two properties matter and both live in migration 0011. **Actuals are never stored
 * here** — every actual is read from `journal_lines` at query time, because a budget
 * table carrying its own copy of what was spent will drift from the ledger and leave the
 * committee with two numbers and no way to tell which is the society's. And **an approved
 * budget cannot be edited**: a budget a treasurer can quietly amend after the AGM is a
 * running commentary, not a budget. A genuine change is a revision that supersedes.
 *
 * `financialYear` is the starting calendar year: 2026 means 1 Apr 2026 to 31 Mar 2027.
 * The Indian financial year is statutory, so it is derived rather than configured.
 */
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    financialYear: integer("financial_year").notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    notes: text("notes"),
    /** `draft` | `approved` | `superseded`. Approval is one-way, by trigger. */
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    /** The AGM or committee resolution it was passed under. */
    approvedRef: varchar("approved_ref", { length: 160 }),
    supersedesId: uuid("supersedes_id"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by"),
    ...timestamps,
  },
  (t) => [index("ix_budget_society").on(t.societyId, t.financialYear)],
);

export const budgetLines = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    societyId: uuid("society_id")
      .notNull()
      .references(() => societies.id),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    /** Against a ledger head, never free text — an unmatched line can have no actual. */
    accountId: uuid("account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    annualAmount: money("annual_amount").notNull().default("0"),
    notes: text("notes"),
  },
  (t) => [index("ix_budget_line_budget").on(t.budgetId)],
);
