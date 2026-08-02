import type { StreamID, WorkGraphContext } from "../contracts"

export type AttentionStream = Readonly<{
  id: StreamID
  title: string
  pinned: boolean
  lastActivityAt: number
}>

export type AttentionPort = Readonly<{
  listActive(context: WorkGraphContext): Promise<readonly AttentionStream[]>
}>

export function createAttentionService(port: AttentionPort) {
  return {
    suggestStreams: async (context: WorkGraphContext, limit = 12) =>
      (await port.listActive(context))
        .toSorted((left, right) => Number(right.pinned) - Number(left.pinned) || right.lastActivityAt - left.lastActivityAt)
        .slice(0, limit),
  }
}
