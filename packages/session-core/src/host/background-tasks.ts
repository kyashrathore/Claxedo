import type { BackgroundTaskRef, BackgroundTaskStopResult } from "@claxedo/harness/contract"
import type { SessionAttachments } from "./attachments"

export type BackgroundTaskStop = BackgroundTaskStopResult | { ok: false; status: "unsupported"; harness: string }

/**
 * Stops one background task on the harness process a session holds. A session
 * that holds none has no task running, so it is answered `not_found` without
 * launching its harness.
 */
export function createBackgroundTaskStops(attachments: Pick<SessionAttachments, "withoutAttaching">) {
  return {
    async stop(sessionId: string, task: BackgroundTaskRef, directory?: string): Promise<BackgroundTaskStop> {
      const read = await attachments.withoutAttaching(sessionId, directory)
      const operations = read.handle.transport.backgroundTasks
      if (!operations) return { ok: false, status: "unsupported", harness: read.handle.runner.id }
      if (!read.attached) return { ok: false, status: "not_found", message: `Session ${sessionId} runs no harness process` }
      return await operations.stop(read.attached.session, task)
    },
  }
}
