import assert from "node:assert/strict"
import type { MessageRow } from "./api"
import { frameSessionId, frameType, isGeneratedTitle, type EventStream } from "./stream"

type Delta = { sessionID?: string; partID?: string; field?: string; delta?: string }

export function liveParts(stream: EventStream, sessionId: string) {
  const parts = new Map<string, Record<string, unknown>>()
  for (const frame of stream.frames) {
    const type = frameType(frame)
    if (type === "message.part.updated") {
      const part = (frame.data.payload as { properties?: { part?: Record<string, unknown> } } | undefined)?.properties?.part
      if (part?.sessionID === sessionId && typeof part.id === "string") parts.set(part.id, { ...part })
    } else if (type === "message.part.delta") {
      const delta = (frame.data.payload as { properties?: Delta } | undefined)?.properties
      if (delta?.sessionID !== sessionId || !delta.partID || !delta.field || typeof delta.delta !== "string") continue
      const part = parts.get(delta.partID)
      if (part) {
        const previous = part[delta.field]
        part[delta.field] = `${typeof previous === "string" ? previous : ""}${delta.delta}`
      }
    }
  }
  return parts
}

export function assertStoredPartsMatchLive(messages: MessageRow[], stream: EventStream, sessionId: string) {
  const live = liveParts(stream, sessionId)
  const stored = messages.flatMap((message) => message.parts)
  for (const part of stored) {
    if (!part.id || part.type === "step-start" || part.type === "step-finish") continue
    const frame = live.get(part.id)
    assert.ok(frame, `stored ${part.type} part ${part.id} has no live counterpart`)
    assert.equal(frame.type, part.type, `part ${part.id} type differs`)
    if (part.type === "text" || part.type === "reasoning") assert.equal(frame.text, part.text, `part ${part.id} text differs`)
    if (part.type === "tool") assert.deepEqual(frame.state, part.state, `part ${part.id} tool state differs`)
  }
  return { live, stored }
}

export function waitForIdle(stream: EventStream, sessionId: string) {
  return stream.waitFor((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionId, {
    label: `${sessionId} session.idle`,
    timeoutMs: 60_000,
  })
}

/** The title a session's first completed turn asks for, published after that turn's idle and before any later turn's frames. */
export function waitForTitle(stream: EventStream, sessionId: string) {
  return stream.waitFor((frame) => isGeneratedTitle(frame, sessionId), { label: `${sessionId} generated title`, timeoutMs: 60_000 })
}

export function assertTurnFinished(messages: MessageRow[], stream: EventStream, sessionId: string) {
  const assistant = messages.filter((message) => message.info.role === "assistant").at(-1)
  assert.ok(assistant, `${sessionId} has no stored assistant message`)
  assert.ok(typeof (assistant.info.time as { completed?: unknown } | undefined)?.completed === "number", `${sessionId} has no stored finish time`)
  assert.ok(stream.frames.some((frame) => frameType(frame) === "session.idle" && frameSessionId(frame) === sessionId), `${sessionId} has no live finish frame`)
}
