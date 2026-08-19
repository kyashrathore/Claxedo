import type { BenchmarkPage as Page } from "./agent-cdp-page"
import {
  beginStreamObservation,
  finishStreamObservation,
  measureSessionActivation,
  type SessionReadinessTarget,
} from "./agent-browser-observer"
import type { AgentAppCorpus, CorpusPart, MaterializedCorpusPart } from "./agent-corpus-materializer"

type LifecycleEvent = {
  id?: unknown
  sequence?: unknown
  atMs?: unknown
  type?: unknown
  messageId?: unknown
  partId?: unknown
  content?: unknown
  callId?: unknown
  toolName?: unknown
  state?: unknown
  inputJson?: unknown
  outputText?: unknown
}

export async function runControlledStreamScenario(input: {
  page: Page
  serverUrl: string
  workspaceDirectory: string
  corpus: AgentAppCorpus
  materializedSessions: Map<string, string>
  materializedParts: Map<string, MaterializedCorpusPart>
  readinessTargets: readonly SessionReadinessTarget[]
}) {
  const session = input.corpus.sessions.toSorted((a, b) => a.order - b.order)[0]
  if (!session) throw new Error("controlled stream requires a corpus session")
  const events = validateEvents(session.events as LifecycleEvent[])
  if (events.length === 0) throw new Error("controlled stream requires lifecycle events")
  const targetParts = new Map<string, CorpusPart>()
  for (const turn of session.turns) {
    for (const message of turn.messages) {
      for (const part of message.parts) targetParts.set(part.id, part)
    }
  }
  const materializedSessionId = input.materializedSessions.get(session.id)
  if (!materializedSessionId) throw new Error(`controlled stream session was not materialized: ${session.id}`)
  const readinessTarget = input.readinessTargets.find((target) => target.sessionId === materializedSessionId)
  if (!readinessTarget) throw new Error(`controlled stream readiness target was not materialized: ${session.id}`)
  await measureSessionActivation(input.page, readinessTarget)
  await beginStreamObservation(input.page)

  const durationMs = events.at(-1)!.atMs
  const probeCount = 40
  const scheduled = [
    ...events.map((event) => ({ atMs: event.atMs, event })),
    ...Array.from({ length: probeCount }, (_, index) => ({
      atMs: Math.round(((index + 0.5) / probeCount) * Math.max(durationMs, probeCount)),
      probe: index,
    })),
  ].toSorted((left, right) => left.atMs - right.atMs || ("event" in left ? -1 : 1))
  const startedAtMs = performance.now()
  for (const item of scheduled) {
    const remaining = startedAtMs + item.atMs - performance.now()
    if (remaining > 0) await Bun.sleep(remaining)
    if ("event" in item) {
      await publishLifecycleEvent({
        serverUrl: input.serverUrl,
        workspaceDirectory: input.workspaceDirectory,
        event: item.event,
        targetParts,
        materializedParts: input.materializedParts,
      })
    } else {
      await input.page.keyboard.press("ArrowDown")
    }
  }

  const finalRevision = [...events].reverse().find((event) => event.type === "message-part-revision")
  if (finalRevision) {
    const tail = finalRevision.content.slice(-128)
    await input.page.waitForFunction((expected) => document.body.textContent?.includes(expected), tail)
  }
  await input.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  const result = await finishStreamObservation(input.page)
  const actualProbeCount = result.evidence?.probeCount ?? 0
  return {
    ...result,
    validity: {
      expectedEvents: events.length,
      actualEvents: events.length,
      expectedProbes: probeCount,
      actualProbes: actualProbeCount,
      finalContentMatched: finalRevision !== undefined,
    },
  }
}

async function publishLifecycleEvent(input: {
  serverUrl: string
  workspaceDirectory: string
  event: ValidLifecycleEvent
  targetParts: Map<string, CorpusPart>
  materializedParts: Map<string, MaterializedCorpusPart>
}) {
  const event = input.event
  if (event.type === "stream-complete") return
  let materialized: MaterializedCorpusPart | undefined
  let payload: Record<string, unknown> | undefined
  if (event.type === "message-part-revision") {
    materialized = input.materializedParts.get(event.partId)
    const corpusPart = input.targetParts.get(event.partId)
    if (!materialized || !corpusPart || materialized.corpusMessageId !== event.messageId) {
      throw new Error(`stream revision references unknown part: ${event.partId}`)
    }
    payload =
      corpusPart.type === "reasoning"
        ? { ...materialized.payload, text: event.content }
        : { type: "text", text: event.content }
  } else {
    materialized = [...input.materializedParts.values()].find((candidate) => candidate.payload.callID === event.callId)
    if (!materialized) throw new Error(`tool lifecycle references unknown call: ${event.callId}`)
    const status = event.state
    const parsedInput = JSON.parse(event.inputJson ?? "{}") as Record<string, unknown>
    const state =
      status === "completed"
        ? {
            status,
            input: parsedInput,
            output: event.outputText ?? "",
            title: event.toolName,
            metadata: {},
            time: { start: 0, end: 1 },
          }
        : status === "error"
          ? { status, input: parsedInput, error: event.outputText ?? "error", time: { start: 0, end: 1 } }
          : status === "running"
            ? { status, input: parsedInput, time: { start: 0 } }
            : { status: "pending", input: parsedInput, raw: event.inputJson ?? "{}" }
    payload = { type: "tool", callID: event.callId, tool: event.toolName, state }
  }
  const body = {
    ...payload,
    id: materialized.partId,
    messageID: materialized.messageId,
    sessionID: materialized.sessionId,
  }
  const url = new URL(
    `/session/${encodeURIComponent(materialized.sessionId)}/message/${encodeURIComponent(materialized.messageId)}/part/${encodeURIComponent(materialized.partId)}`,
    input.serverUrl,
  )
  url.searchParams.set("directory", input.workspaceDirectory)
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`stream replay failed (${String(response.status)}): ${await response.text()}`)
}

type ValidLifecycleEvent =
  | {
      sequence: number
      atMs: number
      type: "message-part-revision"
      messageId: string
      partId: string
      content: string
    }
  | {
      sequence: number
      atMs: number
      type: "tool-lifecycle"
      callId: string
      toolName: string
      state: "pending" | "running" | "completed" | "error"
      inputJson?: string
      outputText?: string
    }
  | { sequence: number; atMs: number; type: "stream-complete" }

function validateEvents(events: LifecycleEvent[]): ValidLifecycleEvent[] {
  return events
    .toSorted((left, right) => Number(left.sequence) - Number(right.sequence))
    .map((event, index) => {
      if (!Number.isInteger(event.sequence) || event.sequence !== index)
        throw new Error("lifecycle event sequence must be contiguous")
      if (!Number.isFinite(event.atMs) || Number(event.atMs) < 0)
        throw new Error("lifecycle event atMs must be non-negative")
      const base = { sequence: index, atMs: Number(event.atMs) }
      if (event.type === "message-part-revision") {
        if (
          typeof event.messageId !== "string" ||
          typeof event.partId !== "string" ||
          typeof event.content !== "string"
        ) {
          throw new Error("invalid message-part-revision event")
        }
        return { ...base, type: event.type, messageId: event.messageId, partId: event.partId, content: event.content }
      }
      if (event.type === "tool-lifecycle") {
        if (
          typeof event.callId !== "string" ||
          typeof event.toolName !== "string" ||
          !["pending", "running", "completed", "error"].includes(String(event.state))
        )
          throw new Error("invalid tool-lifecycle event")
        return {
          ...base,
          type: event.type,
          callId: event.callId,
          toolName: event.toolName,
          state: event.state as "pending" | "running" | "completed" | "error",
          ...(typeof event.inputJson === "string" ? { inputJson: event.inputJson } : {}),
          ...(typeof event.outputText === "string" ? { outputText: event.outputText } : {}),
        }
      }
      if (event.type === "stream-complete") return { ...base, type: event.type }
      throw new Error(`unsupported lifecycle event: ${String(event.type)}`)
    })
}
