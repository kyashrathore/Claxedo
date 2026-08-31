import type { JsonRecord } from "../shared/sdk-runtime-driver"
import { errorMessage } from "../shared/sdk-runtime-values"

const MAX_THREAD_RESUME_ATTEMPTS = 2

/** The app-server has no dedicated error code for an unavailable thread. */
export function isThreadNotFound(error: unknown): boolean {
  return /thread not found/i.test(errorMessage(error))
}

/** Preserve the protocol detail while producing a session-classified message. */
export function sessionLostMessage(cause: unknown): string {
  return `The agent process no longer has this conversation (session not found). ${errorMessage(cause)}`
}

/** Resume a persisted thread into the current app-server process before retrying. */
export async function startTurnWithThreadRecovery(input: {
  startTurn: () => Promise<JsonRecord>
  resumeThread: () => Promise<unknown>
}): Promise<JsonRecord> {
  try {
    return await input.startTurn()
  } catch (error) {
    if (!isThreadNotFound(error)) throw error
    let lastError = error
    for (let attempt = 0; attempt < MAX_THREAD_RESUME_ATTEMPTS; attempt++) {
      await input.resumeThread()
      try {
        return await input.startTurn()
      } catch (retryError) {
        if (!isThreadNotFound(retryError)) throw retryError
        lastError = retryError
      }
    }
    throw new Error(sessionLostMessage(lastError))
  }
}
