
import type { AgentPresentationEvent } from "@claxedo/agent-runtime-contract"

type EventHarnessHealth = Extract<AgentPresentationEvent, { type: "harness.health" }>

export type SessionHarnessHealth = Omit<EventHarnessHealth["properties"], "sessionID">

type Watched = { directory: string; turnActive: boolean; reads: number }

const PUBLISHED_LIMIT = 256

/**
 * Pushes a session's harness health (`harnessHealth` and `connectionState`, as
 * the health route answers them) when it changes. Health means something only
 * around a turn, so a session is watched from its turn's start until the read
 * after the turn ends. Every trigger schedules one read of each watched
 * session on the next task: an adapter reports a change from inside the exit
 * or turn callback that caused it, before the state it describes has settled.
 */
export function createHarnessHealthFeed(input: {
  read: (sessionId: string, directory: string) => Promise<SessionHarnessHealth>
  publish: (directory: string, event: EventHarnessHealth["properties"]) => void
  onReadFailure: (sessionId: string, error: unknown) => void
}) {
  const watched = new Map<string, Watched>()
  const published = new Map<string, string>()
  let scheduled: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function remember(sessionId: string, signature: string) {
    published.delete(sessionId)
    published.set(sessionId, signature)
    if (published.size <= PUBLISHED_LIMIT) return
    const oldest = published.keys().next().value
    if (oldest !== undefined) published.delete(oldest)
  }

  async function refresh(sessionId: string, target: Watched) {
    const read = ++target.reads
    const health = await input.read(sessionId, target.directory).catch((error: unknown) => {
      input.onReadFailure(sessionId, error)
      return undefined
    })
    if (read !== target.reads || watched.get(sessionId) !== target) return
    if (!target.turnActive) watched.delete(sessionId)
    if (!health || disposed) return
    const signature = JSON.stringify(health)
    if (published.get(sessionId) === signature) return
    remember(sessionId, signature)
    input.publish(target.directory, { sessionID: sessionId, ...health })
  }

  function schedule() {
    if (scheduled || disposed) return
    scheduled = setTimeout(() => {
      scheduled = undefined
      for (const [sessionId, target] of watched) void refresh(sessionId, target)
    }, 0)
  }

  return {
    turnStarted(sessionId: string, directory: string) {
      watched.set(sessionId, { directory, turnActive: true, reads: 0 })
      schedule()
    },
    turnEnded(sessionId: string) {
      const target = watched.get(sessionId)
      if (target) target.turnActive = false
      schedule()
    },
    changed: schedule,
    dispose() {
      disposed = true
      if (scheduled) clearTimeout(scheduled)
      watched.clear()
      published.clear()
    },
  }
}

export type HarnessHealthFeed = ReturnType<typeof createHarnessHealthFeed>
