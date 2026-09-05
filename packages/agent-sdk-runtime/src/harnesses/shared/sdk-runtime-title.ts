import { sessionUpdated } from "../../compat-events"
import { deriveSessionTitle, hasConcreteSessionTitle } from "../../session-title"
import type { SdkRuntimeStore } from "./sdk-runtime-driver"
import { extractTextFromParts } from "./sdk-runtime-values"

export function commitSdkAutomaticTitle(store: SdkRuntimeStore, id: string, agentSessionId: string, directory: string, parts: unknown[]) {
  const session = store.getSession(id) as { title?: string | null } | null
  if (hasConcreteSessionTitle(session?.title)) return null
  const text = extractTextFromParts(parts)
  if (!text) return null
  const now = Date.now()
  const event = sessionUpdated({
    id,
    slug: id,
    projectID: "",
    directory,
    title: deriveSessionTitle(text),
    version: "local",
    time: { created: now, updated: now },
  })
  store.appendEvent({
    sessionId: id,
    agentSessionId,
    payload: event,
    source: { dir: "in", method: "auto-title", frame: {} },
  })
  return event
}
