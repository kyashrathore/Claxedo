import type { CompatEvent } from "../../compat-events"
import { sessionUpdated, withDir } from "../../compat-events"
import type { PromptInput } from "../../index"
import { Log } from "../../log"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { hasConcreteSessionTitle } from "../../session-title"
import { newSessionTimeoutMs } from "./helpers"
import type { ACPProcess, SessionUpdate } from "./process"

const log = Log.create({ service: "acp-adapter" })

type ACPTitleStore = {
  getSession(id: string): unknown | null
  appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: CompatEvent
    source?: {
      dir: "in" | "out"
      method: string
      requestId?: string
      frame?: unknown
    }
  }): void
}

export type ACPTitleDeps = {
  store: ACPTitleStore
  eventHub?: RuntimeEventHub
  getOrSpawnProcess(sessionId: string, directory: string): Promise<{ proc: ACPProcess }>
  boot(proc: ACPProcess, directory: string, title?: string): Promise<string>
}

export const fallbackSessionTitle = (text: string) => {
  const cleaned = text.replace(/\s+/g, " ").trim()
  if (/^(hi|hello|hey|yo|greetings)[!. ]*$/i.test(cleaned)) return "Greeting"
  const withoutPolitePrefix = cleaned.replace(/^(please|can you|could you|would you)\s+/i, "").trim()
  const source = withoutPolitePrefix || cleaned
  return source.length > 72 ? source.slice(0, 72).trimEnd() + "…" : source
}

export function chunkDelta(input: unknown) {
  if (!input || typeof input !== "object") return
  const row = input as { sessionUpdate?: unknown; delta?: unknown }
  if (row.sessionUpdate !== "agent_message_chunk") return
  if (typeof row.delta !== "string") return
  return row.delta
}

/** Extract plain text from prompt parts for title generation. */
export function extractTextFromParts(parts: unknown[]): string {
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    const p = part as Record<string, unknown>
    if (p.type === "text" && typeof p.text === "string") return p.text.trim()
    // InputText variant
    if (p.type === "input_text" && typeof p.text === "string") return p.text.trim()
    // Plain string content
    if (typeof p.content === "string") return p.content.trim()
  }
  return ""
}

/** Emit a truncated-text title immediately; fire-and-forget an LLM title generation via ACP. */
export function maybeAutoTitle(
  deps: ACPTitleDeps,
  id: string,
  agentSessionId: string,
  directory: string,
  parts: unknown[],
): CompatEvent | null {
  try {
    const session = deps.store.getSession(id) as { title?: string | null } | null
    if (hasConcreteSessionTitle(session?.title)) return null
    const text = extractTextFromParts(parts)
    if (!text) return null

    // Immediate fallback: truncated user message
    const fallback = fallbackSessionTitle(text)
    const now = Date.now()
    const event = sessionUpdated({
      id,
      slug: id,
      projectID: "",
      directory,
      title: fallback,
      version: "local",
      time: { created: now, updated: now },
    })
    deps.store.appendEvent({
      sessionId: id,
      agentSessionId,
      payload: event,
      source: { dir: "in", method: "auto-title", frame: { title: fallback } },
    })

    // Fire-and-forget: generate a better title via the ACP process
    generateAITitle(deps, id, directory, text).catch((err) => {
      log.warn("generateAITitle: failed (keeping fallback title)", { err })
    })

    return event
  } catch (err) {
    log.warn("maybeAutoTitle: failed", { err })
    return null
  }
}

/** Use the ACP process to generate a short AI title, then push update via SSE. */
export async function generateAITitle(
  deps: ACPTitleDeps,
  sessionId: string,
  directory: string,
  userText: string,
): Promise<void> {
  let proc: ACPProcess
  try {
    const result = await deps.getOrSpawnProcess(sessionId, directory)
    proc = result.proc
  } catch {
    return // no process available
  }

  // Create a temporary ACP session for title generation
  let titleAcpSessionId: string
  try {
    titleAcpSessionId = await deps.boot(proc, directory)
  } catch (err) {
    log.warn("generateAITitle: failed to create temp session", { err })
    return
  }

  // Collect response text via the session update listener
  let responseText = ""
  const truncated = userText.length > 200 ? userText.slice(0, 200) + "…" : userText
  const titleInput: PromptInput = {
    parts: [{ type: "text", text: `Generate a short title (under 10 words, no quotes) for a coding conversation that starts with this message:\n\n${truncated}` }],
    assistantMessageId: `title_${Date.now()}`,
    agent: "title",
    model: { providerID: "", modelID: "" },
  }

  try {
    await titlePrompt(proc, titleAcpSessionId, titleInput, (update) => {
      const delta = chunkDelta(update)
      if (delta) responseText += delta
    })
  } catch (err) {
    log.warn("generateAITitle: prompt failed", { err })
    return
  }

  // Clean up the response
  const cleaned = responseText
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!cleaned) return

  const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned

  // Check current title hasn't been manually set in the meantime
  const fallback = fallbackSessionTitle(userText)
  const current = deps.store.getSession(sessionId) as { title?: string | null } | null
  if (hasConcreteSessionTitle(current?.title) && current?.title !== fallback) {
    return // title was manually updated, don't overwrite
  }

  const now = Date.now()
  const event = sessionUpdated({
    id: sessionId,
    slug: sessionId,
    projectID: "",
    directory,
    title,
    version: "local",
    time: { created: now, updated: now },
  })
  deps.store.appendEvent({
    sessionId,
    payload: event,
    source: { dir: "in", method: "ai-title", frame: { title } },
  })
  // AI title generation is intentionally fire-and-forget after the turn
  // stream has completed, so this update cannot flow through sendMessage().
  // Persist first for replay, then fan out globally for live subscribers.
  deps.eventHub?.publishGlobal(withDir(directory, event))
  log.info("generateAITitle: updated title", { sessionId, title })
}

async function titlePrompt(
  proc: ACPProcess,
  sessionId: string,
  input: PromptInput,
  onUpdate: (update: SessionUpdate) => void,
  ms = newSessionTimeoutMs(),
) {
  let id: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      proc.prompt(sessionId, input, onUpdate),
      new Promise<never>((_, reject) => {
        id = setTimeout(() => reject(new Error(`ACP title prompt timed out after ${ms}ms`)), ms)
      }),
    ])
  } catch (err) {
    await proc.cancel(sessionId).catch(() => {})
    throw err
  } finally {
    if (id) clearTimeout(id)
  }
}
