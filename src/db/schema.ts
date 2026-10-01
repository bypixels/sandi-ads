/**
 * Drizzle schema — Postgres tables for the dashboard.
 *
 * Type definitions only. The actual schema in the database is managed via
 * SQL migrations under `drizzle/` (applied at boot by migrate.ts). Drizzle
 * uses these definitions for query building and type inference.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  primaryUrl: text('primary_url').notNull(),
  bindings: jsonb('bindings').$type<Record<string, string>>().notNull().default({}),
  notes: text('notes'),
  /**
   * Editable marketer-facing metadata: description, niche, brand voice, tags,
   * competitors. Shape owned by `services/site-profile.ts`; this column is a
   * structureless JSONB on purpose so the profile schema can evolve without
   * migrations.
   */
  profile: jsonb('profile').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Site snapshots — generic cache layer for expensive tool outputs.
// Each row is one (siteId, kind) capture. Latest-by-kind is what callers
// consume; older rows are kept for trend/history reads.
// ---------------------------------------------------------------------------

export const siteSnapshots = pgTable(
  'site_snapshots',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    data: jsonb('data').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => ({
    idxSiteKindCaptured: index('site_snapshots_site_kind_captured_idx').on(t.siteId, t.kind, t.capturedAt),
  }),
);

export type SiteSnapshotRow = typeof siteSnapshots.$inferSelect;
export type SiteSnapshotInsert = typeof siteSnapshots.$inferInsert;

// ---------------------------------------------------------------------------
// Audit events — every mutating tool call invoked through the dashboard
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    timestamp: timestamp('timestamp', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    tool: text('tool').notNull(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    input: jsonb('input').notNull(),
    status: text('status', { enum: ['success', 'error', 'blocked'] }).notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    error: text('error'),
    resultSummary: text('result_summary'),
  },
  (t) => ({
    idxTimestamp: index('audit_events_timestamp_idx').on(t.timestamp),
    idxTool: index('audit_events_tool_idx').on(t.tool),
    idxSite: index('audit_events_site_idx').on(t.siteId),
  }),
);

// ---------------------------------------------------------------------------
// Conversations + messages (Anthropic agent chat history)
// ---------------------------------------------------------------------------

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    totalInputTokens: integer('total_input_tokens').notNull().default(0),
    totalOutputTokens: integer('total_output_tokens').notNull().default(0),
    totalCacheReadTokens: integer('total_cache_read_tokens').notNull().default(0),
    totalCacheCreationTokens: integer('total_cache_creation_tokens').notNull().default(0),
  },
  (t) => ({
    idxSite: index('conversations_site_idx').on(t.siteId),
    idxUpdated: index('conversations_updated_idx').on(t.updatedAt),
  }),
);

/**
 * Each row is one Anthropic message — content is the full content array
 * (text, tool_use, tool_result blocks). `seq` preserves order within a
 * conversation; it's part of the primary key so a single conversation
 * cannot have two messages at the same position.
 */
export const conversationMessages = pgTable(
  'conversation_messages',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.seq] }),
  }),
);

// ---------------------------------------------------------------------------
// Type inference helpers (used by repos)
// ---------------------------------------------------------------------------

export type SiteRow = typeof sites.$inferSelect;
export type SiteInsert = typeof sites.$inferInsert;

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type AuditEventInsert = typeof auditEvents.$inferInsert;

export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationInsert = typeof conversations.$inferInsert;

export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type ConversationMessageInsert = typeof conversationMessages.$inferInsert;

// ---------------------------------------------------------------------------
// GSC signals — alert-like records derived from polling the GSC API
// ---------------------------------------------------------------------------

export const gscSignals = pgTable(
  'gsc_signals',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    signalType: text('signal_type').notNull(),
    severity: text('severity', { enum: ['info', 'low', 'warn', 'high', 'critical'] }).notNull(),
    title: text('title').notNull(),
    detail: jsonb('detail').notNull().default({}),
    firstSeen: timestamp('first_seen', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    acknowledged: boolean('acknowledged').notNull().default(false),
  },
  (t) => ({
    idxSite: index('gsc_signals_site_idx').on(t.siteId),
    idxLastSeen: index('gsc_signals_lastseen_idx').on(t.lastSeen),
  }),
);

export type GscSignalRow = typeof gscSignals.$inferSelect;
export type GscSignalInsert = typeof gscSignals.$inferInsert;

// ---------------------------------------------------------------------------
// Linked Google accounts (OAuth)
// ---------------------------------------------------------------------------

export const googleAccounts = pgTable(
  'google_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    name: text('name'),
    pictureUrl: text('picture_url'),
    encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
    encryptionIv: text('encryption_iv').notNull(),
    encryptionTag: text('encryption_tag').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true, mode: 'string' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
  },
);

export type GoogleAccountRow = typeof googleAccounts.$inferSelect;
export type GoogleAccountInsert = typeof googleAccounts.$inferInsert;

// ---------------------------------------------------------------------------
// Drafts — agent-generated artifacts awaiting human review.
// Each row is one editable draft (article body, social post, reply, etc.).
// Status transitions enforced by services/drafts-store.ts, not at the DB.
// ---------------------------------------------------------------------------

export const drafts = pgTable(
  'drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),       // 'writer' | 'social-x' | ...
    draftType: text('draft_type').notNull(),   // 'article' | 'tweet' | ...
    status: text('status', {
      enum: ['pending_review', 'approved', 'published', 'rejected', 'revised'],
    })
      .notNull()
      .default('pending_review'),
    title: text('title').notNull(),
    content: jsonb('content').notNull(),
    sourceRef: jsonb('source_ref'),
    metadata: jsonb('metadata').notNull().default({}),
    reviewedBy: text('reviewed_by'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'string' }),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' }),
  },
  (t) => ({
    idxSiteStatusCreated: index('drafts_site_status_created_idx').on(t.siteId, t.status, t.createdAt),
    idxAgentStatus: index('drafts_agent_status_idx').on(t.agentId, t.status),
  }),
);

export type DraftRow = typeof drafts.$inferSelect;
export type DraftInsert = typeof drafts.$inferInsert;

// Shared inbox for approval decisions; execution remains with the live requester.
export const pendingApprovals = pgTable('pending_approvals', {
  id: uuid('id').primaryKey(),
  siteId: uuid('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull(),
  source: jsonb('source').notNull(),
  action: jsonb('action').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  status: text('status', { enum: ['pending', 'decided', 'consumed'] }).notNull().default('pending'),
  decision: jsonb('decision'),
}, t => ({ idxSiteStatus: index('pending_approvals_site_status_idx').on(t.siteId, t.status, t.expiresAt) }));
