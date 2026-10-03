/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { ServerEvent } from "../events"
import { placementId, projectId, requestId, sessionId } from "../ids"
import { frameFromWire, serverEventFromFrame } from "./frames"
import type { Address } from "./session-row"

const address: Address = {
  placementFor: (directory) => (directory === "/work" ? { placementId: placementId("p1"), projectId: projectId("j1") } : undefined),
}

const ref = { projectId: projectId("j1"), placementId: placementId("p1"), sessionId: sessionId("s1") }

test("frames: a harness.health frame becomes the session's harnessHealthChanged", () => {
  const frame = frameFromWire({
    directory: "/work",
    payload: {
      type: "harness.health",
      properties: {
        sessionID: "s1",
        harnessHealth: { status: "degraded", reason: "harness_process_lost", message: "exited" },
        connectionState: { connectionId: "gw", state: "disconnected", processes: [] },
      },
    },
  })
  expect(frame && serverEventFromFrame(frame, address)).toEqual({
    type: "harnessHealthChanged",
    ref,
    health: { status: "degraded", reason: "harness_process_lost" },
    connectionState: { connectionId: "gw", state: "disconnected" },
  })
})

test("frames: a session.background-work frame becomes the session's backgroundWorkChanged", () => {
  const frame = (agents: unknown) => frameFromWire({ directory: "/work", payload: { type: "session.background-work", properties: { sessionID: "s1", agents, shells: 1, other: 0 } } })
  const started = frame(2)
  const settled = frame(0)
  const garbled = frame("yes")
  expect(started && serverEventFromFrame(started, address)).toEqual({ type: "backgroundWorkChanged", ref, work: { agents: 2, shells: 1, other: 0 } })
  expect(settled && serverEventFromFrame(settled, address)).toEqual({ type: "backgroundWorkChanged", ref, work: { agents: 0, shells: 1, other: 0 } })
  expect(garbled && serverEventFromFrame(garbled, address)).toBeUndefined()
})

test("frames: a turn-end frame carries the turn's lastTurn onto statusChanged; an idle that ends no turn carries none", () => {
  const frame = (type: string, properties: Record<string, unknown>) => frameFromWire({ directory: "/work", payload: { type, properties: { sessionID: "s1", ...properties } } })
  const idle = frame("session.idle", { lastTurn: { status: "cancelled", completedAt: 7 } })
  const failed = frame("session.error", { error: { name: "UnknownError", data: { message: "refused" } }, lastTurn: { status: "failed", completedAt: 8 } })
  const bare = frame("session.idle", {})
  const admissionFailure = frame("session.error", { error: { name: "UnknownError", data: { message: "The harness refused the prompt" } } })
  expect(admissionFailure && serverEventFromFrame(admissionFailure, address), "a failure with no recorded turn is still a failed status").toMatchObject({ type: "statusChanged", ref, status: { kind: "failed" } })
  expect(admissionFailure && serverEventFromFrame(admissionFailure, address)).not.toHaveProperty("lastTurn")
  expect(idle && serverEventFromFrame(idle, address)).toEqual({ type: "statusChanged", ref, status: { kind: "idle" }, lastTurn: { status: "cancelled", completedAt: 7 } })
  expect(failed && serverEventFromFrame(failed, address)).toMatchObject({ type: "statusChanged", ref, status: { kind: "failed" }, lastTurn: { status: "failed", completedAt: 8 } })
  expect(bare && serverEventFromFrame(bare, address)).toEqual({ type: "statusChanged", ref, status: { kind: "idle" } })
})

test("frames: a harness.health frame without a known health status is dropped", () => {
  const frame = frameFromWire({ directory: "/work", payload: { type: "harness.health", properties: { sessionID: "s1", harnessHealth: { status: "fine" } } } })
  expect(frame && serverEventFromFrame(frame, address)).toBeUndefined()
})

test("frames: an expired permission or question closes the request exactly as its reply does", () => {
  const settled = (type: string) => {
    const frame = frameFromWire({ directory: "/work", payload: { type, properties: { sessionID: "s1", requestID: "req-1" } } })
    return frame && serverEventFromFrame(frame, address)
  }
  const closed: ServerEvent = { type: "requestClosed", ref, requestId: requestId("req-1") }
  expect(settled("permission.replied")).toEqual(closed)
  expect(settled("permission.expired")).toEqual(closed)
  expect(settled("question.rejected")).toEqual(closed)
  expect(settled("question.expired")).toEqual(closed)
})

test("frames: a subagent's request opens on the child session its sessionID names, never the parent", () => {
  const opened = (type: string, properties: Record<string, unknown>) => {
    const frame = frameFromWire({ directory: "/work", payload: { type, properties } })
    return frame && serverEventFromFrame(frame, address)
  }
  const child = { ...ref, sessionId: sessionId("child-1") }
  expect(opened("permission.asked", { id: "perm-1", sessionID: "child-1", permission: "bash", patterns: [], always: [], metadata: {} }))
    .toMatchObject({ type: "requestOpened", ref: child, request: { kind: "permission", id: requestId("perm-1") } })
  expect(opened("question.asked", { id: "ask-1", sessionID: "child-1", questions: [] }))
    .toMatchObject({ type: "requestOpened", ref: child, request: { kind: "question", id: requestId("ask-1") } })
})

test("frames: a part retraction names the withdrawn parts and why", () => {
  const frame = frameFromWire({
    directory: "/work",
    payload: { type: "message.part.retracted", properties: { sessionID: "s1", reason: "refusal", parts: [{ messageID: "m1", partID: "p1" }, { messageID: "m1" }] } },
  })
  expect(frame && serverEventFromFrame(frame, address)).toEqual({ type: "partsRetracted", ref, reason: "refusal", parts: [{ messageId: "m1", partId: "p1" }] })
})

test("frames: a hosted status notice becomes the session's statusChanged with its wait, background work and last turn", () => {
  const byWorkspace: Address = {
    placementFor: (directory, workspaceId) => (directory === "workspace:ws_1" && workspaceId === "ws_1" ? { placementId: placementId("p1"), projectId: projectId("j1") } : undefined),
  }
  const notice = (fields: Record<string, unknown>) => frameFromWire({
    type: "session.status.changed",
    ownerUserId: "user_reader",
    orgId: "org_1",
    sessionId: "s1",
    workspaceId: "ws_1",
    status: "idle",
    awaitingInput: false,
    ts: 9,
    ...fields,
  })
  const ended = notice({ lastTurn: { status: "failed", completedAt: 9 } })
  const waiting = notice({ status: "busy", awaitingInput: true, backgroundWork: { agents: 1, shells: 0, other: 0 }, replayed: true })
  const unknownStatus = notice({ status: "thinking" })
  const elsewhere = notice({ workspaceId: "ws_2" })

  expect(ended && serverEventFromFrame(ended, byWorkspace)).toEqual({
    type: "statusChanged",
    ref,
    status: { kind: "idle" },
    waitingOnUser: false,
    backgroundWork: { agents: 0, shells: 0, other: 0 },
    lastTurn: { status: "failed", completedAt: 9 },
  })
  expect(waiting && serverEventFromFrame(waiting, byWorkspace)).toEqual({
    type: "statusChanged",
    ref,
    status: { kind: "working" },
    waitingOnUser: true,
    backgroundWork: { agents: 1, shells: 0, other: 0 },
    replayed: true,
  })
  expect(unknownStatus && serverEventFromFrame(unknownStatus, byWorkspace)).toBeUndefined()
  expect(elsewhere && serverEventFromFrame(elsewhere, byWorkspace)).toBeUndefined()
})

test("frames: a reader notice becomes the session's readerChanged with the marks it carries, located by its workspace", () => {
  const located: Address = { placementFor: (directory, workspaceId) => (directory === "workspace:ws_1" && workspaceId === "ws_1" ? { placementId: placementId("p1"), projectId: projectId("j1") } : undefined) }
  const notice = (workspaceId: string) => frameFromWire({ type: "session.reader.changed", ownerUserId: "local", sessionId: "s1", workspaceId, seenAt: 40, ts: 9 })
  const known = notice("ws_1")
  const unknown = notice("ws_elsewhere")
  expect(known && serverEventFromFrame(known, located)).toEqual({ type: "readerChanged", ref, reader: { seenAt: 40 } })
  expect(unknown && serverEventFromFrame(unknown, located)).toBeUndefined()
})

test("frames: todo and diff frames keep only the entries their contract admits", () => {
  const todo = { content: "write the parser", status: "pending", priority: "high" }
  const todos = frameFromWire({ directory: "/work", payload: { type: "todo.updated", properties: { sessionID: "s1", todos: [todo, { content: "no priority", status: "pending" }] } } })
  const diff = { file: "a.ts", additions: 1, deletions: 0, status: "modified" as const }
  const diffs = frameFromWire({ directory: "/work", payload: { type: "session.diff", properties: { sessionID: "s1", diff: [diff, { ...diff, status: "renamed" }] } } })
  expect(todos && serverEventFromFrame(todos, address)).toEqual({ type: "todosChanged", ref, todos: [todo] })
  expect(diffs && serverEventFromFrame(diffs, address)).toEqual({ type: "diffChanged", ref, diff: [diff] })
})
