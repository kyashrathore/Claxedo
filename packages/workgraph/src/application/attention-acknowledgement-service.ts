import type { AttentionAcknowledgement, WorkGraphContext } from "../contracts"

export type AttentionAcknowledgementStore = Readonly<{
  markAllRead(context: WorkGraphContext): Promise<AttentionAcknowledgement>
  clear(context: WorkGraphContext): Promise<AttentionAcknowledgement>
}>

export function createAttentionAcknowledgementService(store: AttentionAcknowledgementStore) {
  return {
    markAllRead(context: WorkGraphContext) {
      requireOwner(context)
      return store.markAllRead(context)
    },
    clear(context: WorkGraphContext) {
      requireOwner(context)
      return store.clear(context)
    },
  }
}

export type AttentionAcknowledgementService = ReturnType<typeof createAttentionAcknowledgementService>

function requireOwner(context: WorkGraphContext) {
  if (context.access.mode !== "owner") throw new Error("Owner access is required")
}
