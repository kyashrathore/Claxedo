import {
  createMemoryDedupStore,
  type ChannelId,
  type DedupStore,
  type InboundEnvelope,
} from "@claxedo/channels"
import type { ProjectionStore } from "./control-plane/projection-store"

const DEFAULT_WINDOWS = {
  github: 24 * 60 * 60 * 1000,
  slack: 5 * 60 * 1000,
  telegram: 24 * 60 * 60 * 1000,
  discord: 5 * 60 * 1000,
  whatsapp: 5 * 60 * 1000,
} as const satisfies Record<ChannelId, number>

const DEFAULT_DAILY_CEILING = 10

export function createProjectionDedupStore(store: ProjectionStore, options: {
  replayWindows?: Partial<Record<ChannelId, number>>
  dailyCeiling?: number
} = {}): DedupStore {
  const memory = createMemoryDedupStore(options)
  const replayWindows = { ...DEFAULT_WINDOWS, ...options.replayWindows }
  const dailyCeiling = options.dailyCeiling ?? DEFAULT_DAILY_CEILING

  function fallback() {
    return !store.claim_channel_delivery
      || !store.remember_channel_delivery_session
      || !store.count_channel_deliveries_by_user_day
  }

  return {
    async claim(input: InboundEnvelope, claimOptions = {}) {
      if (fallback()) return memory.claim(input, claimOptions)
      return await store.claim_channel_delivery!({
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
        externalUserId: input.externalUserId,
        receivedAt: input.receivedAt ?? claimOptions.now ?? Date.now(),
        now: claimOptions.now ?? Date.now(),
        replayWindowMs: replayWindows[input.channel],
        dailyCeiling,
        reserveSessionCreate: claimOptions.reserveSessionCreate === true,
        ...(claimOptions.sessionId ? { sessionId: claimOptions.sessionId } : {}),
      })
    },
    async rememberSession(input, sessionId, rememberOptions = {}) {
      if (fallback()) {
        await memory.rememberSession(input, sessionId, rememberOptions)
        return
      }
      await store.remember_channel_delivery_session!({
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
        sessionId,
        sessionCreate: rememberOptions.sessionCreate === true,
      })
    },
    async release(input) {
      if (fallback()) {
        await memory.release(input)
        return
      }
      await store.release_channel_delivery?.({
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
      })
    },
    async countByChannelUserDay(input) {
      if (fallback()) return memory.countByChannelUserDay(input)
      return await store.count_channel_deliveries_by_user_day!(input)
    },
  }
}
