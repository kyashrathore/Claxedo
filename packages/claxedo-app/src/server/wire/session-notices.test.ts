/// <reference types="bun" />
import { expect, test } from "bun:test"
import { frameFromWire, serverEventFromFrame } from "./frames"
import { placementId, projectId, sessionId } from "../ids"
import type { Address } from "./session-row"

const ref = { placementId: placementId("workspace-1"), projectId: projectId("project-1"), sessionId: sessionId("session-1") }
const address: Address = { placementFor: () => undefined }
const base = { sessionId: "session-1", workspaceId: "workspace-1", projectId: "project-1", title: "Background work" }
const facts = { sequence: 8, generation: 1, activitySequence: 8, activityAt: 100, outcome: { sequence: 8, completedAt: 100, status: "completed" }, working: false, awaitingInput: false } as const

function mapped(notice: Record<string, unknown>) {
  const frame = frameFromWire(notice)
  return frame && serverEventFromFrame(frame, address)
}

test("private status notices carry facts for unloaded authorized sessions", () => {
  expect(mapped({ ...base, type: "session.status.changed", attention: facts })).toEqual({ type: "attentionChanged", ref, title: base.title, attention: facts, delivery: "live" })
})



test("private removal notices use the existing canonical tombstone event without transcript data", () => {
  expect(mapped({ type: "session.removed", sessionId: base.sessionId, workspaceId: base.workspaceId, projectId: base.projectId })).toEqual({ type: "sessionRemoved", ref })
  expect(() => mapped({ type: "session.removed", sessionId: base.sessionId, workspaceId: base.workspaceId })).toThrow()
})

test("status notices carry the canonical outcome identity used by visible-result acknowledgement", () => {
  const lastTurn = { status: "completed", completedAt: 100, assistantMessageId: "assistant-1" }
  expect(mapped({ ...base, type: "session.status.changed", attention: facts, lastTurn })).toMatchObject({ type: "attentionChanged", lastTurn })
})

test("raised notices retain explicit replay classification from an outer frame", () => {
  const event = { sequence: 9, openedAt: 110, kind: "question", requestId: "q-1" } as const
  expect(mapped({ replayed: true, payload: { ...base, type: "session.attention.raised", generation: 1, event } })).toEqual({ type: "attentionRaised", ref, title: base.title, generation: 1, event, delivery: "replay" })
})

test("a reader notice carries only its server reader state", () => {
  const reader = { generation: 1, revision: 3, seenThrough: 8, seenAt: 120 }
  expect(mapped({ ...base, type: "session.reader.changed", reader })).toEqual({ type: "readerChanged", ref, reader })
})

test("malformed raised identities cannot become notification facts", () => {
  expect(() => mapped({ ...base, type: "session.attention.raised", generation: 1, event: { sequence: 0, openedAt: 1, kind: "question" } })).toThrow()
  expect(() => mapped({ ...base, projectId: undefined, type: "session.status.changed", attention: facts })).toThrow()
  expect(() => mapped({ ...base, type: "session.status.changed" })).toThrow()
  expect(() => mapped({ ...base, type: "session.reader.changed" })).toThrow()
})

test("a known placement maps the canonical notice into its existing project identity", () => {
  const frame = frameFromWire({ ...base, type: "session.status.changed", attention: facts })!
  const known: Address = { placementFor: () => ({ placementId: placementId("local-alias"), projectId: projectId("local-project") }) }
  expect(serverEventFromFrame(frame, known)).toMatchObject({ ref: { ...ref, placementId: placementId("local-alias"), projectId: projectId("local-project") } })
})
