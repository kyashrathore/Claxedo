/**
 * SQLite-backed implementations of the channel access ports
 * (@claxedo/channels ChannelAccessStore + ChannelIdentityBindingStore).
 *
 * Divergence from OpenClaw's file-locked JSON store: pairing state, the
 * approved-sender allowlist, and channel→account identity bindings live in the
 * control plane's own SQLite (durable across restarts, no lock contention).
 * Expired pending rows are pruned lazily on read (their approach) so a
 * long-lived process doesn't accumulate stale codes.
 *
 * Every read here is scoped to `CURRENT_CHANNEL_IDENTITY_VERSION`. A row below
 * it was keyed by whatever string its transport called a sender id, which may
 * be a handle the platform has since handed to somebody else, so it admits
 * nobody and hands back no pending code. It is left in place as history: an
 * explicit approval overwrites it through the upsert below, which is the only
 * way a legacy sender comes back, and which runs after the canonical bind.
 */
import { and, desc, eq, lte } from "drizzle-orm"
import type {
  ChannelAccessStore,
  ChannelIdentityBinding,
  ChannelIdentityBindingStore,
  PairingRequest,
} from "@claxedo/channels"
import { ClaxedoDB } from "../platform/db"
import { channelId } from "./channel-id"
import {
  ClaxedoChannelAllowTable,
  ClaxedoChannelIdentityTable,
  ClaxedoChannelPairingTable,
  CURRENT_CHANNEL_IDENTITY_VERSION,
} from "./access.sql"

/** A row whose channel is no longer a supported one reads as absent, exactly as `identity` treats an unknown status. */
function pairing(row: typeof ClaxedoChannelPairingTable.$inferSelect): PairingRequest | undefined {
  const channel = channelId(row.channel)
  if (!channel) return undefined
  return {
    code: row.code,
    channel,
    externalUserId: row.external_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSentAt: row.last_sent_at,
  }
}

const current = eq(ClaxedoChannelPairingTable.identity_version, CURRENT_CHANNEL_IDENTITY_VERSION)

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
            eq(ClaxedoChannelAllowTable.identity_version, CURRENT_CHANNEL_IDENTITY_VERSION),
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
        identity_version: CURRENT_CHANNEL_IDENTITY_VERSION,
      }).onConflictDoUpdate({
        target: [ClaxedoChannelAllowTable.channel, ClaxedoChannelAllowTable.external_user_id],
        set: {
          approved_by: approvedBy ?? null,
          approved_at: now(),
          identity_version: CURRENT_CHANNEL_IDENTITY_VERSION,
        },
      }).run())
    },
    async disallow(channel, externalUserId) {
      ClaxedoDB.use((db) => db.delete(ClaxedoChannelAllowTable)
        .where(and(
          eq(ClaxedoChannelAllowTable.channel, channel),
          eq(ClaxedoChannelAllowTable.external_user_id, externalUserId),
        ))
        .run())
    },
    async listPending(channel) {
      pruneExpired(now())
      return ClaxedoDB.use((db) =>
        db.select().from(ClaxedoChannelPairingTable)
          .where(and(
            current,
            channel ? eq(ClaxedoChannelPairingTable.channel, channel) : undefined,
          ))
          .orderBy(desc(ClaxedoChannelPairingTable.created_at))
          .all(),
      ).flatMap((row) => pairing(row) ?? [])
    },
    async findPending(code) {
      pruneExpired(now())
      const row = ClaxedoDB.use((db) =>
        db.select().from(ClaxedoChannelPairingTable)
          .where(and(eq(ClaxedoChannelPairingTable.code, code), current))
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
            current,
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
        identity_version: CURRENT_CHANNEL_IDENTITY_VERSION,
      }).onConflictDoUpdate({
        target: ClaxedoChannelPairingTable.code,
        set: {
          channel: request.channel,
          external_user_id: request.externalUserId,
          created_at: request.createdAt,
          expires_at: request.expiresAt,
          last_sent_at: request.lastSentAt,
          identity_version: CURRENT_CHANNEL_IDENTITY_VERSION,
        },
      }).run())
    },
    async deletePending(code) {
      // Prune first so the conditional delete only ever sees live rows; the
      // version predicate keeps legacy rows out of the consume count (they are
      // history, not approvable codes). `changes` is what makes the consume
      // atomic — two racing deletes cannot both report a removal.
      pruneExpired(now())
      const result = ClaxedoDB.use((db) => db.delete(ClaxedoChannelPairingTable)
        .where(and(eq(ClaxedoChannelPairingTable.code, code), current))
        .run())
      return result.changes > 0
    },
  }
}

const currentIdentity = eq(ClaxedoChannelIdentityTable.identity_version, CURRENT_CHANNEL_IDENTITY_VERSION)

function identity(row: typeof ClaxedoChannelIdentityTable.$inferSelect): ChannelIdentityBinding | undefined {
  const status = row.status
  const channel = channelId(row.channel)
  if (!channel || (status !== "pending" && status !== "bound" && status !== "blocked")) return undefined
  return {
    channel,
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
            currentIdentity,
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
            currentIdentity,
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
        identity_version: CURRENT_CHANNEL_IDENTITY_VERSION,
      }).onConflictDoUpdate({
        target: [ClaxedoChannelIdentityTable.channel, ClaxedoChannelIdentityTable.external_user_id],
        set: {
          account_id: binding.accountId ?? null,
          status: binding.status,
          bound_at: binding.boundAt,
          bound_by: binding.boundBy ?? null,
          identity_version: CURRENT_CHANNEL_IDENTITY_VERSION,
        },
      }).run())
    },
    async delete(channel, externalUserId) {
      ClaxedoDB.use((db) => db.delete(ClaxedoChannelIdentityTable)
        .where(and(
          eq(ClaxedoChannelIdentityTable.channel, channel),
          eq(ClaxedoChannelIdentityTable.external_user_id, externalUserId),
        ))
        .run())
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
        currentIdentity,
      ))
      .get(),
  )
  const bound = row ? identity(row) : undefined
  return bound?.status === "bound" ? bound.accountId : null
}
