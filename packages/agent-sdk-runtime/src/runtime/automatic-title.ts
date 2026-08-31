import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { AgentSession, PromptInput } from "../index"
import { buildSession, sessionUpdated, type CompatEvent } from "../compat-events"
import { extractPromptTitleText, fallbackSessionTitle, hasConcreteSessionTitle } from "../session-title"

type AutomaticTitleStore = {
  getSession(sessionId: string): unknown | null
}

export type AutomaticTitleInput = {
  sessionId: string
  directory: string | undefined
  prompt: PromptInput
  store: AutomaticTitleStore
  updateSession(sessionId: string, title: string, directory: string | undefined): Promise<AgentSession | null>
  commit(event: CompatEvent): void
  diagnose(event: AgentRuntimeEvent): void
}

/**
 * Automatic titles are post-turn metadata. A provider failure here must never
 * rewrite the already-authoritative turn outcome as failed.
 */
export async function tryUpdateAutomaticTitle(input: AutomaticTitleInput): Promise<void> {
  const session = input.store.getSession(input.sessionId) as {
    title?: string | null
    time?: { created?: number }
  } | null
  if (hasConcreteSessionTitle(session?.title)) return
  const text = extractPromptTitleText(input.prompt.parts)
  if (!text) return
  const title = fallbackSessionTitle(text)

  try {
    const updated = await input.updateSession(input.sessionId, title, input.directory)
    if (!updated) throw new Error("Harness did not accept the automatic session title")
    input.commit(sessionUpdated(buildSession({
      id: input.sessionId,
      directory: input.directory ?? "",
      title,
      created: session?.time?.created,
      updated: Date.now(),
    })))
  } catch (error) {
    input.diagnose({
      type: "diagnostic",
      diagnostic: {
        code: "automatic_title_update_failed",
        message: error instanceof Error ? error.message : "Automatic session title update failed",
        severity: "warn",
        source: "agent-sdk-runtime",
        method: "session.auto-title",
        details: { sessionId: input.sessionId },
      },
    })
  }
}
