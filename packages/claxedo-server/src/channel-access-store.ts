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
import type {
  ChannelAccessStore,
  ChannelId,
  ChannelIdentityBinding,
  ChannelIdentityBindingStore,
  PairingRequest,
} from "@claxedo/channels"
import { ClaxedoDB } from "./storage/db"

function pairingRow(input: unknown): PairingRequest | undefined {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  const code = typeof row.code === "string" ? row.code : undefined
  const channel = typeof row.channel === "string" ? row.channel : undefined
  const externalUserId = typeof row.external_user_id === "string" ? row.external_user_id : undefined
  const createdAt = typeof row.created_at === "number" ? row.created_at : undefined
  const expiresAt = typeof row.expires_at === "number" ? row.expires_at : undefined
  const lastSentAt = typeof row.last_sent_at === "number" ? row.last_sent_at : undefined
  if (!code || !channel || !externalUserId || createdAt === undefined || expiresAt === undefined || lastSentAt === undefined) return
  return { code, channel: channel as ChannelId, externalUserId, createdAt, expiresAt, lastSentAt }
}

function pruneExpired(now: number) {
  ClaxedoDB.raw().prepare(`DELETE FROM claxedo_channel_pairing WHERE expires_at <= ?`).run(now)
}

export function createSqliteChannelAccessStore(now: () => number = Date.now): ChannelAccessStore {
  return {
    async isAllowed(channel, externalUserId) {
      const row = ClaxedoDB.raw().prepare(
        `SELECT 1 FROM claxedo_channel_allow WHERE channel = ? AND external_user_id = ?`,
      ).get(channel, externalUserId)
      return !!row
    },
    async allow(channel, externalUserId, approvedBy) {
      ClaxedoDB.raw().prepare(`
        INSERT INTO claxedo_channel_allow (channel, external_user_id, approved_by, approved_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(channel, external_user_id) DO UPDATE SET
          approved_by = excluded.approved_by,
          approved_at = excluded.approved_at
      `).run(channel, externalUserId, approvedBy ?? null, now())
    },
    async listPending(channel) {
      pruneExpired(now())
      const rows = channel
        ? ClaxedoDB.raw().prepare(`SELECT * FROM claxedo_channel_pairing WHERE channel = ? ORDER BY created_at DESC`).all(channel)
        : ClaxedoDB.raw().prepare(`SELECT * FROM claxedo_channel_pairing ORDER BY created_at DESC`).all()
      return rows.flatMap((row) => pairingRow(row) ?? [])
    },
    async findPending(code) {
      pruneExpired(now())
      return pairingRow(ClaxedoDB.raw().prepare(`SELECT * FROM claxedo_channel_pairing WHERE code = ?`).get(code))
    },
    async findPendingBySender(channel, externalUserId) {
      pruneExpired(now())
      return pairingRow(ClaxedoDB.raw().prepare(
        `SELECT * FROM claxedo_channel_pairing WHERE channel = ? AND external_user_id = ? ORDER BY created_at DESC LIMIT 1`,
      ).get(channel, externalUserId))
    },
    async putPending(request) {
      ClaxedoDB.raw().prepare(`
        INSERT INTO claxedo_channel_pairing (code, channel, external_user_id, created_at, expires_at, last_sent_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          channel = excluded.channel,
          external_user_id = excluded.external_user_id,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at,
          last_sent_at = excluded.last_sent_at
      `).run(request.code, request.channel, request.externalUserId, request.createdAt, request.expiresAt, request.lastSentAt)
    },
    async deletePending(code) {
      ClaxedoDB.raw().prepare(`DELETE FROM claxedo_channel_pairing WHERE code = ?`).run(code)
    },
  }
}

function identityRow(input: unknown): ChannelIdentityBinding | undefined {
  if (!input || typeof input !== "object") return
  const row = input as Record<string, unknown>
  const channel = typeof row.channel === "string" ? row.channel : undefined
  const externalUserId = typeof row.external_user_id === "string" ? row.external_user_id : undefined
  const status = row.status
  const boundAt = typeof row.bound_at === "number" ? row.bound_at : undefined
  if (!channel || !externalUserId || boundAt === undefined) return
  if (status !== "pending" && status !== "bound" && status !== "blocked") return
  return {
    channel: channel as ChannelId,
    externalUserId,
    accountId: typeof row.account_id === "string" ? row.account_id : null,
    status,
    boundAt,
    ...(typeof row.bound_by === "string" ? { boundBy: row.bound_by } : {}),
  }
}

export function createSqliteChannelIdentityBindingStore(): ChannelIdentityBindingStore {
  return {
    async get(channel, externalUserId) {
      return identityRow(ClaxedoDB.raw().prepare(
        `SELECT * FROM claxedo_channel_identity WHERE channel = ? AND external_user_id = ?`,
      ).get(channel, externalUserId))
    },
    async put(binding) {
      ClaxedoDB.raw().prepare(`
        INSERT INTO claxedo_channel_identity (channel, external_user_id, account_id, status, bound_at, bound_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, external_user_id) DO UPDATE SET
          account_id = excluded.account_id,
          status = excluded.status,
          bound_at = excluded.bound_at,
          bound_by = excluded.bound_by
      `).run(
        binding.channel,
        binding.externalUserId,
        binding.accountId ?? null,
        binding.status,
        binding.boundAt,
        binding.boundBy ?? null,
      )
    },
  }
}

/** Look up the account bound to a channel sender (for session placement). */
export function boundAccountId(channel: string, externalUserId: string): string | null {
  const row = identityRow(ClaxedoDB.raw().prepare(
    `SELECT * FROM claxedo_channel_identity WHERE channel = ? AND external_user_id = ?`,
  ).get(channel, externalUserId))
  return row?.status === "bound" ? row.accountId : null
}
