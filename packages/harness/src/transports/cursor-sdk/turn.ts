import { createAgentEventRuntime } from "../../translate/runtime"
import { cursorRuntimeMessage, cursorSdkAdapter, cursorSubagentObservations, type CursorRunResult } from "./translate"
import { AsyncPushQueue } from "@claxedo/helpers"
import type { SDKImage, SDKMessage, SDKUserMessage } from "@cursor/sdk"
import type { RoutedEvent, TurnBroker, TurnInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { attachmentPathLine, isPromptImage, materializeAttachment, promptFiles } from "../../translate/attachments"
import { routedIngest } from "../../translate/ingest"
import { flattenTurnPrompt } from "../../translate/prompt"
import { CursorDeltaRoutes } from "./deltas"
import { cursorRunResultMissing, cursorRunStatusUnknown } from "./errors"
import type { CursorHost } from "./host-registry"
import type { HostReply, HostSession } from "./protocol"

type Runtime = ReturnType<typeof createAgentEventRuntime>

const cursorAttachmentError = (message: string) => new TransportError("cursor", "configuration", message)

export async function cursorPrompt(turn: TurnInput, directory: string): Promise<string | SDKUserMessage> {
  const lines = [flattenTurnPrompt(turn, { separator: "\n\n", system: "prefix" })]
  const { files, references } = promptFiles(turn, cursorAttachmentError)
  if (references.length) throw cursorAttachmentError(`Cursor cannot deliver the file URL ${references[0]}`)
  const images: SDKImage[] = []
  for (const file of files) {
    const written = await materializeAttachment(directory, file, cursorAttachmentError)
    lines.push(attachmentPathLine(written))
    if (isPromptImage(file.mime)) images.push({ data: file.base64, mimeType: file.mime })
  }
  const text = lines.filter(Boolean).join("\n")
  return images.length ? { text, images } : text
}

function isRunStatus(status: string): status is CursorRunResult["status"] {
  return status === "finished" || status === "cancelled" || status === "error"
}

function runResultEvents(runtime: Runtime, reply: HostReply): RoutedEvent[] {
  if (reply.kind !== "result") return []
  const value = reply.value
  if (!value?.runId || !value.agentId || !value.status) throw cursorRunResultMissing()
  if (!isRunStatus(value.status)) throw cursorRunStatusUnknown(value.status)
  const payload: CursorRunResult = { schemaVersion: 1, type: "result", agentId: value.agentId, runId: value.runId, status: value.status,
    ...(value.error ? { error: value.error } : {}) }
  return routedIngest(runtime, { source: "cursor.local-run-stream", method: "result", payload }, { method: "cursor.result" })
}

function messageEvents(runtime: Runtime, message: SDKMessage): RoutedEvent[] {
  return routedIngest(runtime, { source: "cursor.sdk.message", method: `cursor/${message.type}`, payload: cursorRuntimeMessage(message) },
    { method: `cursor.${message.type}`, target: { kind: "parent" } })
}

async function admitSubagents(message: SDKMessage, broker: TurnBroker): Promise<void> {
  for (const observation of cursorSubagentObservations(message)) {
    const child = await broker.observeSubagent(observation)
    if (!child) continue
    for (const key of [observation.toolCallId, observation.providerId]) if (key) broker.associateChild(key, child)
  }
}

export type CursorRun = {
  host: CursorHost
  session: HostSession
  prompt: string | SDKUserMessage
  mode?: "plan"
  broker: TurnBroker
}

export async function* streamCursorRun(input: CursorRun): AsyncIterable<RoutedEvent> {
  if (input.broker.signal.aborted) return
  const queue = new AsyncPushQueue<HostReply>()
  const runtime = createAgentEventRuntime({ harness: "cursor", threadId: input.session.sessionId, adapter: cursorSdkAdapter() })
  const deltas = new CursorDeltaRoutes(runtime)
  const onAbort = () => {
    void input.host.call({ kind: "cancel", sessionId: input.session.sessionId }).then(() => {}, (error: unknown) => queue.fail(error))
  }
  input.broker.signal.addEventListener("abort", onAbort, { once: true })
  try {
    const request = input.host.call({ kind: "run", session: input.session, prompt: input.prompt,
      ...(input.mode ? { mode: input.mode } : {}) }, (reply) => queue.push(reply))
    void request.then((reply) => { queue.push(reply); queue.end() }, (error: unknown) => queue.fail(error))
    if (input.broker.signal.aborted) onAbort()
    for await (const reply of queue) {
      if (reply.kind === "delta") {
        yield* deltas.events(reply.update)
        continue
      }
      if (reply.kind === "event") {
        await admitSubagents(reply.message, input.broker)
        yield* messageEvents(runtime, reply.message)
        continue
      }
      yield* runResultEvents(runtime, reply)
    }
  } finally {
    input.broker.signal.removeEventListener("abort", onAbort)
  }
}
