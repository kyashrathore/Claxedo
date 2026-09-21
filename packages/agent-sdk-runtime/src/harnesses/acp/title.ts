import { asRecord } from "@claxedo/agent-runtime-contract"
import type { PromptInput } from "../../index"
import { Log } from "../../log"
import type { SessionTitleRequest } from "../../title-generation"
import { newSessionTimeoutMs } from "./helpers"
import type { ACPProcess, SessionUpdate } from "./process"

const log = Log.create({ service: "acp-adapter" })

export type ACPTitleDeps = {
  getOrSpawnProcess(sessionId: string, directory: string): Promise<{ proc: ACPProcess }>
  boot(proc: ACPProcess, directory: string, title?: string): Promise<string>
}

/** The text of an agent message chunk, when `input` is one. */
export function chunkDelta(input: unknown): string | undefined {
  const row = asRecord(input)
  if (row?.sessionUpdate !== "agent_message_chunk") return undefined
  return typeof row.delta === "string" ? row.delta : undefined
}

/**
 * The title side turn on ACP: a throwaway session on the session's own
 * process, so the agent's transcript for the real session never sees the
 * title prompt. Returns the raw reply; the runtime cleans it.
 */
export async function generateAcpTitle(deps: ACPTitleDeps, sessionId: string, request: SessionTitleRequest): Promise<string | null> {
  const { proc } = await deps.getOrSpawnProcess(sessionId, request.directory)
  const titleSessionId = await deps.boot(proc, request.directory)
  let responseText = ""
  const input: PromptInput = {
    parts: [{ type: "text", text: `${request.system}\n\n${request.user}` }],
    assistantMessageId: `title_${Date.now()}`,
    agent: "title",
    ...(request.model ? { model: request.model } : {}),
  }
  try {
    await titlePrompt(proc, titleSessionId, request.directory, input, (update) => {
      const delta = chunkDelta(update)
      if (delta) responseText += delta
    }, request.signal)
  } catch (err) {
    log.warn("generateAcpTitle: prompt failed", { err })
    return null
  }
  return responseText
}

async function titlePrompt(
  proc: ACPProcess,
  sessionId: string,
  directory: string,
  input: PromptInput,
  onUpdate: (update: SessionUpdate) => void,
  signal: AbortSignal,
  ms = newSessionTimeoutMs(),
) {
  let id: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => proc.cancel(sessionId).catch(() => {})
  signal.addEventListener("abort", onAbort, { once: true })
  try {
    return await Promise.race([
      proc.prompt(sessionId, input, onUpdate, directory),
      new Promise<never>((_, reject) => {
        id = setTimeout(() => reject(new Error(`ACP title prompt timed out after ${ms}ms`)), ms)
      }),
    ])
  } catch (err) {
    await proc.cancel(sessionId).catch(() => {})
    throw err
  } finally {
    signal.removeEventListener("abort", onAbort)
    if (id) clearTimeout(id)
  }
}
