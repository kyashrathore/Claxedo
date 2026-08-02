/**
 * SQLite-backed implementations of the channel access ports
 * (@claxedo/channels ChannelAccessStore + ChannelIdentityBindingStore).
 *
 * Divergence from OpenClaw's file-locked JSON store: pairing state, the
 * approved-sender allowlist, and channel→account identity bindings live in the
 * control plane's own SQLite (durable across restarts, no lock contention).
 * Expired pending rows are pruned lazily on read (their approach) so a
 * long-lived process doesn't accumulate stale codes.
 */
import { and, desc, eq, lte } from "drizzle-orm"
import type {
  ChannelAccessStore,
  ChannelId,
  ChannelIdentityBinding,
  ChannelIdentityBindingStore,
  PairingRequest,
} from "@claxedo/channels"
import { ClaxedoDB } from "../platform/db/db"
import {
  ClaxedoChannelAllowTable,
  ClaxedoChannelIdentityTable,
  ClaxedoChannelPairingTable,
} from "../platform/db/channel-access.sql"

function pairing(row: typeof ClaxedoChannelPairingTable.$inferSelect): PairingRequest {
  return {
    code: row.code,
    channel: row.channel as ChannelId,
    externalUserId: row.external_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSentAt: row.last_sent_at,
  }
}

function pruneExpired(now: number) {
  ClaxedoDB.use((db) => db.delete(ClaxedoChannelPairingTable)
    .where(lte(ClaxedoChannelPairingTable.expires_at, now))
    .run())
}

export function createSqliteChannelAccessStore(now: () => number = Date.now): ChannelAccessStore {
  return {
    async isAllowed(channel, externalUserId) {
      const row = ClaxedoDB.use((db) =>
        db.select({ channel: ClaxedoChannelAllowTable.channel }).from(ClaxedoChannelAllowTable)
          .where(and(
            eq(ClaxedoChannelAllowTable.channel, channel),
            eq(ClaxedoChannelAllowTable.external_user_id, externalUserId),
          ))
          .get(),
      )
      return !!row
    },
    async allow(channel, externalUserId, approvedBy) {
      ClaxedoDB.use((db) => db.insert(ClaxedoChannelAllowTable).values({
        channel,
        external_user_id: externalUserId,
        approved_by: approvedBy ?? null,
        approved_at: now(),
      }).onConflictDoUpdate({
        target: [ClaxedoChannelAllowTable.channel, ClaxedoChannelAllowTable.external_user_id],
        set: { approved_by: approvedBy ?? null, approved_at: now() },
      }).run())
    },
    async listPending(channel) {
      pruneExpired(now())
      return ClaxedoDB.use((db) =>
        db.select().from(ClaxedoChannelPairingTable)
          .where(channel ? eq(ClaxedoChannelPairingTable.channel, channel) : undefined)
          .orderBy(desc(ClaxedoChannelPairingTable.created_at))
          .all(),
      ).map(pairing)
    },
    async findPending(code) {
      pruneExpired(now())
      const row = ClaxedoDB.use((db) =>
        db.select().from(ClaxedoChannelPairingTable)
          .where(eq(ClaxedoChannelPairingTable.code, code))
          .get(),
      )
      return row ? pairing(row) : undefined
    },
    async findPendingBySender(channel, externalUserId) {
      pruneExpired(now())
      const row = ClaxedoDB.use((db) =>
        db.select().from(ClaxedoChannelPairingTable)
          .where(and(
            eq(ClaxedoChannelPairingTable.channel, channel),
            eq(ClaxedoChannelPairingTable.external_user_id, externalUserId),
          ))
          .orderBy(desc(ClaxedoChannelPairingTable.created_at))
          .limit(1)
          .get(),
      )
      return row ? pairing(row) : undefined
    },
    async putPending(request) {
      ClaxedoDB.use((db) => db.insert(ClaxedoChannelPairingTable).values({
        code: request.code,
        channel: request.channel,
        external_user_id: request.externalUserId,
        created_at: request.createdAt,
        expires_at: request.expiresAt,
        last_sent_at: request.lastSentAt,
      }).onConflictDoUpdate({
        target: ClaxedoChannelPairingTable.code,
        set: {
          channel: request.channel,
          external_user_id: request.externalUserId,
          created_at: request.createdAt,
          expires_at: request.expiresAt,
          last_sent_at: request.lastSentAt,
        },
      }).run())
    },
    async deletePending(code) {
      ClaxedoDB.use((db) => db.delete(ClaxedoChannelPairingTable)
        .where(eq(ClaxedoChannelPairingTable.code, code))
        .run())
    },
  }
}

function identity(row: typeof ClaxedoChannelIdentityTable.$inferSelect): ChannelIdentityBinding | undefined {
  const status = row.status
  if (status !== "pending" && status !== "bound" && status !== "blocked") return
  return {
    channel: row.channel as ChannelId,
    externalUserId: row.external_user_id,
    accountId: row.account_id ?? null,
    status,
    boundAt: row.bound_at,
    ...(row.bound_by ? { boundBy: row.bound_by } : {}),
  }
}

export function createSqliteChannelIdentityBindingStore(): ChannelIdentityBindingStore {
  return {
    async get(channel, externalUserId) {
      const row = ClaxedoDB.use((db) =>
        db.select().from(ClaxedoChannelIdentityTable)
          .where(and(
            eq(ClaxedoChannelIdentityTable.channel, channel),
            eq(ClaxedoChannelIdentityTable.external_user_id, externalUserId),
          ))
          .get(),
      )
      return row ? identity(row) : undefined
    },
    async listBoundForAccount(accountId) {
      return ClaxedoDB.use((db) =>
        db.select().from(ClaxedoChannelIdentityTable)
          .where(and(
            eq(ClaxedoChannelIdentityTable.account_id, accountId),
            eq(ClaxedoChannelIdentityTable.status, "bound"),
          ))
          .orderBy(desc(ClaxedoChannelIdentityTable.bound_at))
          .all(),
      ).flatMap((row) => identity(row) ?? [])
    },
    async put(binding) {
      ClaxedoDB.use((db) => db.insert(ClaxedoChannelIdentityTable).values({
        channel: binding.channel,
        external_user_id: binding.externalUserId,
        account_id: binding.accountId ?? null,
        status: binding.status,
        bound_at: binding.boundAt,
        bound_by: binding.boundBy ?? null,
      }).onConflictDoUpdate({
        target: [ClaxedoChannelIdentityTable.channel, ClaxedoChannelIdentityTable.external_user_id],
        set: {
          account_id: binding.accountId ?? null,
          status: binding.status,
          bound_at: binding.boundAt,
          bound_by: binding.boundBy ?? null,
        },
      }).run())
    },
  }
}

/** Look up the account bound to a channel sender (for session placement). */
export function boundAccountId(channel: string, externalUserId: string): string | null {
  const row = ClaxedoDB.use((db) =>
    db.select().from(ClaxedoChannelIdentityTable)
      .where(and(
        eq(ClaxedoChannelIdentityTable.channel, channel),
        eq(ClaxedoChannelIdentityTable.external_user_id, externalUserId),
      ))
      .get(),
  )
  const bound = row ? identity(row) : undefined
  return bound?.status === "bound" ? bound.accountId : null
}
