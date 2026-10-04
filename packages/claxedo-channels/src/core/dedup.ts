import type { ChannelId, InboundEnvelope } from "../envelope"

export type DedupDecision =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; sessionId?: string }
  | { ok: false; reason: "stale_delivery"; message: string }
  | { ok: false; reason: "daily_ceiling_exceeded"; message: string }

export type DedupStore = {
  claim(input: InboundEnvelope, options?: { sessionId?: string; now?: number; reserveSessionCreate?: boolean }): Promise<DedupDecision>
  rememberSession(input: InboundEnvelope, sessionId: string, options?: { sessionCreate?: boolean }): Promise<void>
  release(input: InboundEnvelope): Promise<void>
  countByChannelUserDay(input: { channel: ChannelId; externalUserId: string; day: string }): Promise<number>
}

const DEFAULT_WINDOWS = {
  github: 24 * 60 * 60 * 1000,
  slack: 5 * 60 * 1000,
  telegram: 24 * 60 * 60 * 1000,
  discord: 5 * 60 * 1000,
  whatsapp: 5 * 60 * 1000,
} as const satisfies Record<ChannelId, number>

const DEFAULT_DAILY_CEILING = 10

type Entry = {
  firstSeenAt: number
  channel: ChannelId
  externalUserId: string
  sessionId?: string
  sessionCreate?: boolean
}

function day(ts: number) {
  return new Date(ts).toISOString().slice(0, 10)
}

function key(input: Pick<InboundEnvelope, "channel" | "idempotencyKey">) {
  return `${input.channel}:${input.idempotencyKey}`
}

export function createMemoryDedupStore(options: {
  replayWindows?: Partial<Record<ChannelId, number>>
  dailyCeiling?: number
  initializedAt?: number
} = {}): DedupStore {
  const replayWindows = { ...DEFAULT_WINDOWS, ...options.replayWindows }
  const initializedAt = options.initializedAt ?? Date.now()
  const dailyCeiling = options.dailyCeiling ?? DEFAULT_DAILY_CEILING
  const entries = new Map<string, Entry>()

  const countSessionCreates = (input: { channel: ChannelId; externalUserId: string; day: string }) =>
    [...entries.values()].filter((item) =>
      item.channel === input.channel
      && item.externalUserId === input.externalUserId
      && day(item.firstSeenAt) === input.day
      && item.sessionCreate === true,
    ).length

  return {
    async claim(input, claimOptions = {}) {
      const now = claimOptions.now ?? Date.now()
      const receivedAt = input.receivedAt ?? now
      const windowMs = replayWindows[input.channel]
      if (receivedAt < now - windowMs || receivedAt < initializedAt) {
        return {
          ok: false,
          reason: "stale_delivery",
          message: "Channel delivery is outside the replay acceptance window",
        }
      }

      const id = key(input)
      const existing = entries.get(id)
      if (existing) return { ok: true, duplicate: true, ...(existing.sessionId ? { sessionId: existing.sessionId } : {}) }

      const countKey = { channel: input.channel, externalUserId: input.externalUserId, day: day(now) }
      if (claimOptions.reserveSessionCreate === true && countSessionCreates(countKey) >= dailyCeiling) {
        return {
          ok: false,
          reason: "daily_ceiling_exceeded",
          message: "Daily channel session ceiling exceeded",
        }
      }

      entries.set(id, {
        firstSeenAt: now,
        channel: input.channel,
        externalUserId: input.externalUserId,
        ...(claimOptions.reserveSessionCreate ? { sessionCreate: true } : {}),
        ...(claimOptions.sessionId ? { sessionId: claimOptions.sessionId } : {}),
      })
      return { ok: true, duplicate: false }
    },
    async rememberSession(input, sessionId, rememberOptions = {}) {
      const existing = entries.get(key(input))
      if (!existing) return
      entries.set(key(input), {
        ...existing,
        sessionId,
        ...(rememberOptions.sessionCreate === undefined ? {} : { sessionCreate: rememberOptions.sessionCreate }),
      })
    },
    async release(input) {
      entries.delete(key(input))
    },
    async countByChannelUserDay(input) {
      return countSessionCreates(input)
    },
  }
}
