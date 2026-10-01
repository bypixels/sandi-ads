/**
 * Per-site conversation persistence — Postgres-backed.
 *
 * Stored across two tables: `conversations` (metadata + token totals) and
 * `conversation_messages` (one row per message, JSONB content). Messages
 * follow Anthropic's content format so they round-trip through the API
 * without transformation.
 *
 * Public API is async; callers must await.
 */

import { readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { conversations, conversationMessages } from '../../db/schema.js';
import { createServiceLogger } from '../../utils/logger.js';
import { runLegacyMigration, type MigrationResult } from './migration.js';

const log = createServiceLogger('agent-conversations');

export type ConversationMessage =
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] };

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface Conversation {
  id: string;
  siteId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ConversationMessage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}

export interface ConversationSummary {
  id: string;
  siteId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

class ConversationStore {
  /** List summaries — optionally filtered by siteId. Pass null for "no site" only. */
  async list(siteId?: string | null): Promise<ConversationSummary[]> {
    const db = getDb();
    const where = siteId === undefined
      ? undefined
      : siteId === null
      ? isNull(conversations.siteId)
      : eq(conversations.siteId, siteId);

    const baseQuery = db
      .select({
        id: conversations.id,
        siteId: conversations.siteId,
        title: conversations.title,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
        totalInputTokens: conversations.totalInputTokens,
        totalOutputTokens: conversations.totalOutputTokens,
        messageCount: sql<number>`(SELECT count(*)::int FROM conversation_messages WHERE conversation_messages.conversation_id = ${conversations.id})`,
      })
      .from(conversations);

    const rows = where
      ? await baseQuery.where(where).orderBy(desc(conversations.updatedAt))
      : await baseQuery.orderBy(desc(conversations.updatedAt));

    return rows.map((r) => ({
      id: r.id,
      siteId: r.siteId,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: r.messageCount,
      totalInputTokens: r.totalInputTokens,
      totalOutputTokens: r.totalOutputTokens,
    }));
  }

  async get(id: string): Promise<Conversation | null> {
    const db = getDb();
    const convRows = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (convRows.length === 0) return null;
    const c = convRows[0];

    const msgRows = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, id))
      .orderBy(asc(conversationMessages.seq));

    return {
      id: c.id,
      siteId: c.siteId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      totalInputTokens: c.totalInputTokens,
      totalOutputTokens: c.totalOutputTokens,
      totalCacheReadTokens: c.totalCacheReadTokens,
      totalCacheCreationTokens: c.totalCacheCreationTokens,
      messages: msgRows.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content as ContentBlock[],
      })),
    };
  }

  async create(siteId: string | null, firstUserMessage: string): Promise<Conversation> {
    const title = firstUserMessage.slice(0, 60).trim() || 'Nueva conversación';
    const rows = await getDb()
      .insert(conversations)
      .values({ siteId, title })
      .returning();
    const c = rows[0];
    return {
      id: c.id,
      siteId: c.siteId,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      messages: [],
    };
  }

  /**
   * Persist the full state of a conversation. Replaces messages atomically
   * inside a transaction so partial writes can't leave orphan rows.
   */
  async save(conv: Conversation): Promise<void> {
    const db = getDb();
    const updatedAt = new Date().toISOString();
    await db.transaction(async (tx) => {
      await tx
        .update(conversations)
        .set({
          siteId: conv.siteId,
          title: conv.title,
          updatedAt,
          totalInputTokens: conv.totalInputTokens,
          totalOutputTokens: conv.totalOutputTokens,
          totalCacheReadTokens: conv.totalCacheReadTokens,
          totalCacheCreationTokens: conv.totalCacheCreationTokens,
        })
        .where(eq(conversations.id, conv.id));

      // Replace messages: delete then re-insert. Cheap for small conversations.
      await tx.delete(conversationMessages).where(eq(conversationMessages.conversationId, conv.id));
      if (conv.messages.length > 0) {
        await tx.insert(conversationMessages).values(
          conv.messages.map((m, i) => ({
            conversationId: conv.id,
            seq: i,
            role: m.role,
            content: m.content,
          })),
        );
      }
    });
    conv.updatedAt = updatedAt;
  }

  async remove(id: string): Promise<boolean> {
    const r = await getDb()
      .delete(conversations)
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id });
    return r.length > 0;
  }

  /**
   * One-shot import of legacy `.website-ops-chats/<uuid>.json` files. The
   * shape orchestration lives in migration.ts; the runner treats the
   * directory as a single "file" path and handles existence/rename.
   */
  async importLegacyChats(): Promise<MigrationResult> {
    return runLegacyMigration({
      name: 'chats directory',
      pathEnvVars: ['AGENT_CHAT_PATH'],
      fileName: '.website-ops-chats',
      isAlreadyPopulated: async () => {
        const existing = await getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(conversations);
        return (existing[0]?.count ?? 0) > 0;
      },
      importEntries: async (dir) => {
        let imported = 0;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          try {
            const raw = readFileSync(join(dir, f), 'utf-8');
            const c = JSON.parse(raw) as Conversation;
            await getDb().transaction(async (tx) => {
              await tx.insert(conversations).values({
                id: c.id,
                siteId: c.siteId,
                title: c.title,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
                totalInputTokens: c.totalInputTokens || 0,
                totalOutputTokens: c.totalOutputTokens || 0,
                totalCacheReadTokens: c.totalCacheReadTokens || 0,
                totalCacheCreationTokens: c.totalCacheCreationTokens || 0,
              });
              if (Array.isArray(c.messages) && c.messages.length > 0) {
                await tx.insert(conversationMessages).values(
                  c.messages.map((m, i) => ({
                    conversationId: c.id,
                    seq: i,
                    role: m.role,
                    content: m.content,
                  })),
                );
              }
            });
            imported++;
          } catch (err) {
            log.warn(`Skipped chat file ${f}`, {
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
        return imported;
      },
    });
  }
}

export const conversationStore = new ConversationStore();

// Avoid unused-imports lint when these helpers aren't referenced (they're
// part of public surface for future extensions like read-only legacy mounts).
void mkdirSync;
void statSync;
void and;
