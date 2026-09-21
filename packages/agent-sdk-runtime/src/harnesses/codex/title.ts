import { asRecord } from "@claxedo/helpers/guards"
import { controlRequestDeadline, modelRequestDeadline } from "../shared/request-deadline"
import { Log } from "../../log"
import type { SessionTitleRequest } from "../../title-generation"
import { text, type JsonRecord } from "../shared/sdk-runtime-adapter"
import type { RequestDeadline } from "../../launch"


const log = Log.create({ service: "codex-title" })

export type CodexTitleProcess = {
  request(method: string, params: unknown, deadline: RequestDeadline): Promise<unknown>
  onMessage(listener: (message: JsonRecord) => void): () => void
}

export type CodexTitleInput = {
  request: SessionTitleRequest
  process(): Promise<CodexTitleProcess>
  lease(): { release(): void }
  /** App-server model id; absent runs the server default. */
  model?: string
  modelProvider?: string
  config: JsonRecord
}

/**
 * The same recipe Codex's own TUI uses to name a thread: an ephemeral,
 * read-only thread on the session's app-server, one structured turn, the
 * thread archived afterwards. The app-server has no title generation of
 * its own — `thread/name/set` only stores what a client hands it.
 */
export async function generateCodexTitle(input: CodexTitleInput): Promise<string | null> {
  const lease = input.lease()
  try {
    const proc = await input.process()
    const started = asRecord(await proc.request("thread/start", {
      cwd: input.request.directory,
      ephemeral: true,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      developerInstructions: input.request.system,
      ...(input.model ? { model: input.model } : {}),
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      config: input.config,
    }, controlRequestDeadline()))
    const threadId = text(asRecord(started?.thread)?.id)
    if (!threadId) return null
    try {
      return await titleTurn(proc, threadId, input)
    } finally {
      await proc.request("thread/archive", { threadId }, controlRequestDeadline()).catch(() => {})
    }
  } catch (error) {
    log.warn("Codex title turn failed", { error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    lease.release()
  }
}

/** Write an accepted title to the thread so `codex resume` lists the same name. */
export async function setCodexThreadName(proc: CodexTitleProcess | null, threadId: string, title: string) {
  if (!proc || !title.trim()) return
  await proc.request("thread/name/set", { threadId, name: title }, controlRequestDeadline()).catch((error: unknown) => {
    log.warn("thread/name/set failed", { threadId, error: error instanceof Error ? error.message : String(error) })
  })
}

function titleTurn(proc: CodexTitleProcess, threadId: string, input: CodexTitleInput) {
  return new Promise<string | null>((resolve, reject) => {
    let turnId: string | undefined
    let message = ""
    const finish = (value: string | null) => {
      cleanup()
      resolve(value)
    }
    const onAbort = () => {
      if (turnId) void proc.request("turn/interrupt", { threadId, turnId }, controlRequestDeadline()).catch(() => {})
      finish(null)
    }
    const unsubscribe = proc.onMessage((frame) => {
      const params = asRecord(frame.params)
      if (!params || text(params.threadId) !== threadId) return
      if (frame.method === "item/completed") {
        const item = asRecord(params.item)
        if (item?.type === "agentMessage" && typeof item.text === "string") message = item.text
      } else if (frame.method === "turn/completed") {
        const turn = asRecord(params.turn)
        const status = text(turn?.status)
        if (status === "failed") reject(new Error(text(asRecord(turn?.error)?.message) ?? "Codex title turn failed"))
        else finish(titleFromReply(message))
      }
    })
    const cleanup = () => {
      unsubscribe()
      input.request.signal.removeEventListener("abort", onAbort)
    }
    input.request.signal.addEventListener("abort", onAbort, { once: true })
    proc.request("turn/start", {
      threadId,
      input: [{ type: "text", text: input.request.user }],
      cwd: input.request.directory,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly" },
      ...(input.model ? { model: input.model } : {}),
      outputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
    }, modelRequestDeadline()).then((response) => {
      turnId = text(asRecord(asRecord(response)?.turn)?.id)
      if (input.request.signal.aborted) onAbort()
    }, (error: unknown) => {
      cleanup()
      reject(error)
    })
  })
}

/** The structured reply's `title`; the raw text when the model ignored the schema. */
function titleFromReply(reply: string) {
  const trimmed = reply.trim()
  if (!trimmed) return null
  try {
    const parsed = asRecord(JSON.parse(trimmed))
    return typeof parsed?.title === "string" ? parsed.title : trimmed
  } catch {
    return trimmed
  }
}
