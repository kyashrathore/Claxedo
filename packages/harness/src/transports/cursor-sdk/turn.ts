import { createAgentEventRuntime } from "../../translate/runtime"
import { cursorRuntimeMessage, cursorSdkAdapter, cursorSubagentObservations } from "./translate"
import type { SubagentTranscript } from "@claxedo/agent-runtime-contract"
import { AsyncPushQueue } from "@claxedo/helpers"
import { asRecord } from "@claxedo/helpers/guards"
import type { SDKImage, SDKMessage, SDKUserMessage } from "@cursor/sdk"
import type { HarnessServices, RoutedEvent, TurnBroker, TurnInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import { attachmentPathLine, isPromptImage, materializeAttachment, promptFiles } from "../../translate/attachments"
import { routedIngest } from "../../translate/ingest"
import { flattenTurnPrompt } from "../../translate/prompt"
import { unrecognizedEvent } from "../../translate/unrecognized"
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

function runResultEvents(runtime: Runtime, reply: HostReply): RoutedEvent[] {
  if (reply.kind !== "result") return []
  const value = reply.value
  if (!value?.runId || !value.agentId || !value.status) throw new TransportError("cursor", "sdk", "Cursor omitted its run result")
  const status = value.status
  if (status !== "finished" && status !== "cancelled" && status !== "error") {
    throw new TransportError("cursor", "sdk", `Cursor reported unknown run status ${status}`)
  }
  return routedIngest(runtime, { source: "cursor.local-run-stream", method: "result",
    payload: { type: "result", agentId: value.agentId, runId: value.runId, status,
      ...(value.result ? { result: value.result } : {}) } }, { method: "cursor.result" })
}

function messageEvents(runtime: Runtime, message: SDKMessage): RoutedEvent[] {
  return routedIngest(runtime, { source: "cursor.sdk.message", method: `cursor/${message.type}`,
    payload: cursorRuntimeMessage(message) }, { method: `cursor.${message.type}`, target: { kind: "parent" },
    mapEvent: (event) => event.type === "diagnostic" && event.diagnostic.code.includes("unmapped")
      ? unrecognizedEvent("cursor.sdk", message.type, message) : event,
  })
}

function taskTranscriptPath(message: SDKMessage): string | undefined {
  if (message.type !== "tool_call" || message.name.toLowerCase() !== "task" || message.status !== "completed") return undefined
  const result = asRecord(message.result)
  if (result?.status !== "success") return undefined
  const transcriptPath = asRecord(result.value)?.transcriptPath
  return typeof transcriptPath === "string" ? transcriptPath : undefined
}

async function transcriptOf(message: SDKMessage, services: HarnessServices, parentSessionId: string): Promise<SubagentTranscript> {
  const filePath = taskTranscriptPath(message)
  if (!filePath) return { kind: "none" }
  const registered = await services.transcripts.register({ parentSessionId, providerKind: "cursor-agent", filePath })
  return registered.state === "ready" ? { kind: "file", ref: registered.handle } : { kind: "none" }
}

async function admitSubagents(message: SDKMessage, broker: TurnBroker, services: HarnessServices, parentSessionId: string): Promise<void> {
  const observations = cursorSubagentObservations(message)
  if (!observations.length) return
  const transcript = await transcriptOf(message, services, parentSessionId)
  for (const observation of observations) {
    const child = await broker.observeSubagent({ ...observation, transcript })
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
  services: HarnessServices
}

export async function* streamCursorRun(input: CursorRun): AsyncIterable<RoutedEvent> {
  const queue = new AsyncPushQueue<HostReply>()
  const runtime = createAgentEventRuntime({ harness: "cursor", threadId: input.session.sessionId, adapter: cursorSdkAdapter() })
  const onAbort = () => {
    void input.host.call({ kind: "cancel", sessionId: input.session.sessionId }).then(() => {}, (error: unknown) => queue.fail(error))
  }
  input.broker.signal.addEventListener("abort", onAbort, { once: true })
  try {
    const request = input.host.call({ kind: "run", session: input.session, prompt: input.prompt,
      ...(input.mode ? { mode: input.mode } : {}) }, (reply) => queue.push(reply))
    void request.then((reply) => { queue.push(reply); queue.end() }, (error: unknown) => queue.fail(error))
    if (input.broker.signal.aborted) onAbort()
    while (true) {
      const next = await queue.next()
      if (next.done) break
      const reply = next.value
      if (reply.kind === "event") {
        await admitSubagents(reply.message, input.broker, input.services, input.session.sessionId)
        yield* messageEvents(runtime, reply.message)
        continue
      }
      yield* runResultEvents(runtime, reply)
      if (reply.kind === "result" && reply.value?.status === "error") throw new TransportError("cursor", "sdk", "Cursor run failed")
    }
  } finally {
    input.broker.signal.removeEventListener("abort", onAbort)
  }
}
