import { and, count as countFn, eq, gte, isNull, lt } from "drizzle-orm"
import { ClaxedoDB } from "../platform/db"
import { ClaxedoChannelDeliveryTable, ClaxedoChannelStateTable } from "./delivery.sql"

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

const INITIALIZED_AT_KEY = "channel_dedup.initialized_at"
const DAY_MS = 24 * 60 * 60 * 1000

function dayStart(input: number) {
  const date = new Date(input)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

type Tx = Parameters<Parameters<typeof ClaxedoDB.transaction>[0]>[0]

function initializedAt(tx: Tx, now: number) {
  const seeded = now - DAY_MS
  tx.insert(ClaxedoChannelStateTable)
    .values({ key: INITIALIZED_AT_KEY, value: String(seeded), updated_at: now })
    .onConflictDoNothing()
    .run()
  const hit = tx.select({ value: ClaxedoChannelStateTable.value }).from(ClaxedoChannelStateTable)
    .where(eq(ClaxedoChannelStateTable.key, INITIALIZED_AT_KEY))
    .get()
  const parsed = Number(hit?.value)
  return Number.isFinite(parsed) ? parsed : now
}

function sessionCreateCountForDay(tx: Tx, input: { channel: string; externalUserId: string; start: number }) {
  const hit = tx.select({ count: countFn() }).from(ClaxedoChannelDeliveryTable)
    .where(and(
      eq(ClaxedoChannelDeliveryTable.channel, input.channel),
      eq(ClaxedoChannelDeliveryTable.external_user_id, input.externalUserId),
      eq(ClaxedoChannelDeliveryTable.session_create, 1),
      gte(ClaxedoChannelDeliveryTable.first_seen_at, input.start),
      lt(ClaxedoChannelDeliveryTable.first_seen_at, input.start + DAY_MS),
    ))
    .get()
  return hit?.count ?? 0
}

export async function claimChannelDelivery(input: ChannelDeliveryClaimInput): Promise<ChannelDeliveryDecision> {
  return ClaxedoDB.transaction((tx): ChannelDeliveryDecision => {
    const storeInitializedAt = initializedAt(tx, input.now)
    if (input.receivedAt < input.now - input.replayWindowMs || input.receivedAt < storeInitializedAt) {
      return {
        ok: false,
        reason: "stale_delivery",
        message: "Channel delivery is outside the replay acceptance window",
      }
    }

    const existing = tx.select({ session_id: ClaxedoChannelDeliveryTable.session_id })
      .from(ClaxedoChannelDeliveryTable)
      .where(and(
        eq(ClaxedoChannelDeliveryTable.channel, input.channel),
        eq(ClaxedoChannelDeliveryTable.idempotency_key, input.idempotencyKey),
      ))
      .get()
    if (existing) {
      const sessionId = existing.session_id && existing.session_id.trim() ? existing.session_id : undefined
      return { ok: true, duplicate: true, ...(sessionId ? { sessionId } : {}) }
    }

    const start = dayStart(input.now)
    const count = sessionCreateCountForDay(tx, { channel: input.channel, externalUserId: input.externalUserId, start })
    if (input.reserveSessionCreate === true && count >= input.dailyCeiling) {
      return {
        ok: false,
        reason: "daily_ceiling_exceeded",
        message: "Daily channel session ceiling exceeded",
      }
    }

    tx.insert(ClaxedoChannelDeliveryTable).values({
      channel: input.channel,
      idempotency_key: input.idempotencyKey,
      external_user_id: input.externalUserId,
      received_at: input.receivedAt,
      first_seen_at: input.now,
      session_id: input.sessionId ?? null,
      session_create: input.reserveSessionCreate === true ? 1 : 0,
    }).run()
    return { ok: true, duplicate: false }
  })
}

export async function rememberChannelDeliverySession(input: {
  channel: string
  idempotencyKey: string
  sessionId: string
  sessionCreate?: boolean
}) {
  ClaxedoDB.use((db) => db.update(ClaxedoChannelDeliveryTable)
    .set({ session_id: input.sessionId, session_create: input.sessionCreate === true ? 1 : 0 })
    .where(and(
      eq(ClaxedoChannelDeliveryTable.channel, input.channel),
      eq(ClaxedoChannelDeliveryTable.idempotency_key, input.idempotencyKey),
    ))
    .run())
}

export async function releaseChannelDelivery(input: {
  channel: string
  idempotencyKey: string
}) {
  ClaxedoDB.use((db) => db.delete(ClaxedoChannelDeliveryTable)
    .where(and(
      eq(ClaxedoChannelDeliveryTable.channel, input.channel),
      eq(ClaxedoChannelDeliveryTable.idempotency_key, input.idempotencyKey),
      isNull(ClaxedoChannelDeliveryTable.session_id),
    ))
    .run())
}

export async function countChannelDeliveriesByUserDay(input: {
  channel: string
  externalUserId: string
  day: string
}) {
  const start = Date.parse(`${input.day}T00:00:00.000Z`)
  if (!Number.isFinite(start)) return 0
  return ClaxedoDB.use((db) => sessionCreateCountForDay(db as unknown as Tx, {
    channel: input.channel,
    externalUserId: input.externalUserId,
    start,
  }))
}
