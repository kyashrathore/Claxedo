import type { SessionAttachments } from "./attachments"
import type { createSessionTitleOwner } from "./session-titles"

type IdleReleaseInput = {
  attachments: Pick<SessionAttachments, "release">
  titles: Pick<ReturnType<typeof createSessionTitleOwner>, "settled">
  report: (sessionId: string, error: unknown) => void
}

/**
 * Lets go of a session's harness execution at the moments the host knows it
 * has nothing more to run for now: once the session is created, and once a
 * turn has settled together with the title it may generate. The transport
 * decides whether the execution is quiescent; the host only asks.
 */
export function createIdleRelease(input: IdleReleaseInput) {
  return {
    async settle(sessionId: string): Promise<void> {
      try {
        await input.titles.settled(sessionId)
        await input.attachments.release(sessionId)
      } catch (error) {
        input.report(sessionId, error)
      }
    },
  }
}
