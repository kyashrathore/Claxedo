import type { SessionAttentionFacts, SessionRef } from "@claxedo/agent-runtime-contract"

type PublicationOrigin = { generation: number; through: number; activitySequence: number; replayed: boolean }

/** Preserve an observed row's origin through row batching, polling and failed publication. */
export function createSessionPublicationOrigins() {
  const origins = new Map<string, PublicationOrigin>()
  return {
    remember(ref: SessionRef, attention: SessionAttentionFacts, replayed: boolean): boolean {
      const key = JSON.stringify([ref.workspaceId, ref.sessionId])
      const previous = origins.get(key)
      // An asynchronous collection may resume with a row captured before a live observation.
      if (previous && (previous.generation > attention.generation
        || previous.generation === attention.generation && previous.through > attention.sequence)) return replayed
      const sameActivity = previous?.activitySequence === attention.activitySequence
      const origin = previous?.generation === attention.generation && sameActivity ? previous.replayed : replayed
      origins.set(key, { generation: attention.generation, through: attention.sequence, activitySequence: attention.activitySequence,
        replayed: origin })
      return origin
    },
    reset() { origins.clear() },
  }
}
