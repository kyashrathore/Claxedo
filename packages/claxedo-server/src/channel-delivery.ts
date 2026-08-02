import { ClaxedoDB } from "./storage/db"

export type ChannelDeliveryDecision =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; sessionId?: string }
  | { ok: false; reason: "stale_delivery"; message: string }
  | { ok: false; reason: "daily_ceiling_exceeded"; message: string }

export type ChannelDeliveryClaimInput = {
  channel: string
  idempotencyKey: string
  externalUserId: string
  receivedAt: number
  now: number
  replayWindowMs: number
  dailyCeiling: number
  sessionId?: string
  reserveSessionCreate?: boolean
}

type Row = Record<string, unknown>

const INITIALIZED_AT_KEY = "channel_dedup.initialized_at"

function row(input: unknown): Row | undefined {
  return input && typeof input === "object" ? input as Row : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function dayStart(input: number) {
  const date = new Date(input)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function initializedAt(now: number) {
  const sqlite = ClaxedoDB.raw()
  const seeded = now - 24 * 60 * 60 * 1000
  sqlite.prepare(`
    INSERT OR IGNORE INTO claxedo_channel_state (key, value, updated_at)
    VALUES (?, ?, ?)
  `).run(INITIALIZED_AT_KEY, String(seeded), now)
  const hit = row(sqlite.prepare("SELECT value FROM claxedo_channel_state WHERE key = ?").get(INITIALIZED_AT_KEY))
  return Number(text(hit?.value) ?? now)
}

function duplicate(input: unknown): Extract<ChannelDeliveryDecision, { duplicate: true }> | undefined {
  const hit = row(input)
  if (!hit) return
  return {
    ok: true,
    duplicate: true,
    ...(text(hit.session_id) ? { sessionId: text(hit.session_id) } : {}),
  }
}

export async function claimChannelDelivery(input: ChannelDeliveryClaimInput): Promise<ChannelDeliveryDecision> {
  const sqlite = ClaxedoDB.raw()
  return sqlite.transaction(() => {
    const storeInitializedAt = initializedAt(input.now)
    if (input.receivedAt < input.now - input.replayWindowMs || input.receivedAt < storeInitializedAt) {
      return {
        ok: false,
        reason: "stale_delivery",
        message: "Channel delivery is outside the replay acceptance window",
      } satisfies ChannelDeliveryDecision
    }

    const existing = duplicate(sqlite.prepare(`
      SELECT session_id
      FROM claxedo_channel_delivery
      WHERE channel = ? AND idempotency_key = ?
    `).get(input.channel, input.idempotencyKey))
    if (existing) return existing

    const start = dayStart(input.now)
    const count = num(row(sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM claxedo_channel_delivery
      WHERE channel = ? AND external_user_id = ? AND session_create = 1 AND first_seen_at >= ? AND first_seen_at < ?
    `).get(input.channel, input.externalUserId, start, start + 24 * 60 * 60 * 1000))?.count) ?? 0
    if (input.reserveSessionCreate === true && count >= input.dailyCeiling) {
      return {
        ok: false,
        reason: "daily_ceiling_exceeded",
        message: "Daily channel session ceiling exceeded",
      } satisfies ChannelDeliveryDecision
    }

    sqlite.prepare(`
      INSERT INTO claxedo_channel_delivery (
        channel,
        idempotency_key,
        external_user_id,
        received_at,
        first_seen_at,
        session_id,
        session_create
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.channel,
      input.idempotencyKey,
      input.externalUserId,
      input.receivedAt,
      input.now,
      input.sessionId ?? null,
      input.reserveSessionCreate === true ? 1 : 0,
    )
    return { ok: true, duplicate: false } satisfies ChannelDeliveryDecision
  })() as ChannelDeliveryDecision
}

export async function rememberChannelDeliverySession(input: {
  channel: string
  idempotencyKey: string
  sessionId: string
  sessionCreate?: boolean
}) {
  ClaxedoDB.raw().prepare(`
    UPDATE claxedo_channel_delivery
    SET session_id = ?, session_create = ?
    WHERE channel = ? AND idempotency_key = ?
  `).run(input.sessionId, input.sessionCreate === true ? 1 : 0, input.channel, input.idempotencyKey)
}

export async function releaseChannelDelivery(input: {
  channel: string
  idempotencyKey: string
}) {
  ClaxedoDB.raw().prepare(`
    DELETE FROM claxedo_channel_delivery
    WHERE channel = ? AND idempotency_key = ? AND session_id IS NULL
  `).run(input.channel, input.idempotencyKey)
}

export async function countChannelDeliveriesByUserDay(input: {
  channel: string
  externalUserId: string
  day: string
}) {
  const start = Date.parse(`${input.day}T00:00:00.000Z`)
  if (!Number.isFinite(start)) return 0
  return num(row(ClaxedoDB.raw().prepare(`
    SELECT COUNT(*) AS count
    FROM claxedo_channel_delivery
    WHERE channel = ? AND external_user_id = ? AND session_create = 1 AND first_seen_at >= ? AND first_seen_at < ?
  `).get(input.channel, input.externalUserId, start, start + 24 * 60 * 60 * 1000))?.count) ?? 0
}
