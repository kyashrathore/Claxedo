import { asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import type { SessionTitleRequest } from "@claxedo/agent-runtime-contract"
import type { v2 } from "@claxedo/agent-event-runtime/harnesses/codex"
import type { HarnessServices, SessionBroker, StartInput } from "../../contract"
import { projectCodexThreadConfig } from "./configuration"
import { CodexTransportError } from "./errors"
import type { CodexRpc } from "./rpc"

export type TitleEntry = { rpc: CodexRpc; start: StartInput; brokered: boolean; broker: SessionBroker; sideThreads: Set<string> }

const titleSchema = { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false }

function parseCodexTitle(reply: string): string | null {
  const text = reply.trim()
  if (!text) return null
  try {
    const value = asString(asRecordOrEmpty(JSON.parse(text)).title)
    return value ?? text
  } catch {
    return text
  }
}

async function startTitleThread(entry: TitleEntry, request: SessionTitleRequest, services: HarnessServices, model: string | undefined): Promise<string> {
  const params: v2.ThreadStartParams = { cwd: request.directory, ephemeral: true, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "read-only",
    developerInstructions: request.system, ...(model ? { model } : {}), ...(entry.brokered ? { modelProvider: "broker" } : {}),
    config: projectCodexThreadConfig(entry.start, services) }
  const started = asRecordOrEmpty(await entry.rpc.request("thread/start", params))
  const threadId = asString(asRecordOrEmpty(started.thread).id)
  if (!threadId) throw new CodexTransportError("protocol", "Codex returned no title thread id")
  return threadId
}

function codexTitleTurn(entry: TitleEntry, threadId: string, request: SessionTitleRequest, model: string | undefined): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    let turnId: string | undefined
    let message = ""
    const finish = (value: string | null) => { cleanup(); resolve(value) }
    const fail = (error: unknown) => { cleanup(); reject(error) }
    const onAbort = () => {
      if (turnId) void entry.rpc.request("turn/interrupt", { threadId, turnId }).catch((error: unknown) => entry.broker.reportFailure(error))
      finish(null)
    }
    const removeMessage = entry.rpc.onMessage((frame) => {
      const params = asRecordOrEmpty(frame.params)
      if (asString(params.threadId) !== threadId) return
      const item = asRecordOrEmpty(params.item)
      if (frame.method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") message = item.text
      if (frame.method !== "turn/completed") return
      const turn = asRecordOrEmpty(params.turn)
      if (turn.status === "failed") fail(new CodexTransportError("session", asString(asRecordOrEmpty(turn.error).message) ?? "Codex title turn failed"))
      else finish(parseCodexTitle(message))
    })
    const removeFailure = entry.rpc.onFailure(fail)
    const cleanup = () => { removeMessage(); removeFailure(); request.signal.removeEventListener("abort", onAbort) }
    request.signal.addEventListener("abort", onAbort, { once: true })
    const params: v2.TurnStartParams = { threadId, input: [{ type: "text", text: request.user, text_elements: [] }], cwd: request.directory,
      approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(model ? { model } : {}), outputSchema: titleSchema }
    entry.rpc.request("turn/start", params, 60_000).then((response) => {
      turnId = asString(asRecordOrEmpty(asRecordOrEmpty(response).turn).id)
      if (request.signal.aborted) onAbort()
    }, fail)
  })
}

export async function codexSessionTitle(entry: TitleEntry, request: SessionTitleRequest, services: HarnessServices): Promise<string | null> {
  const model = request.model?.modelID === "default" ? undefined : request.model?.modelID
  const threadId = await startTitleThread(entry, request, services, model)
  entry.sideThreads.add(threadId)
  try {
    return await codexTitleTurn(entry, threadId, request, model)
  } finally {
    await entry.rpc.request("thread/archive", { threadId }).catch((error: unknown) => entry.broker.reportFailure(error))
  }
}

export async function codexRename(entry: Pick<TitleEntry, "rpc">, threadId: string, name: string): Promise<void> {
  await entry.rpc.request("thread/name/set", { threadId, name })
}
