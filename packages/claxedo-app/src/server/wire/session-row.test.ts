/// <reference types="bun" />
import { expect, test } from "bun:test"
import { placementId, projectId, sessionId } from "../ids"
import { listedStatusFromListItem, sessionRowFromListItem, sessionRowFromSession } from "./session-row"

const ref = { projectId: projectId("project-1"), placementId: placementId("placement-1"), sessionId: sessionId("s1") }

test("session row: a session's saved config names its harness, model and permission mode", () => {
  const row = sessionRowFromSession({
    id: "s1",
    time: { created: 1 },
    config: { harness: { id: "claude", access: "native" }, model: { providerID: "claude", modelID: "claude-haiku-4-5-20251001" }, variant: "high", agent: null, permissionMode: "plan" },
  } as Parameters<typeof sessionRowFromSession>[0], ref)
  expect([row.harness, row.model, row.permissionMode]).toEqual([{ kind: "native", harnessId: "claude" }, { providerId: "claude", modelId: "claude-haiku-4-5-20251001", variant: "high" }, "plan"])
  const modelless = sessionRowFromSession({ id: "s1", config: { harness: { id: "scripted-acp", access: "connection" }, variant: null } } as Parameters<typeof sessionRowFromSession>[0], ref)
  expect([modelless.harness, modelless.model]).toEqual([{ kind: "connection", connectionId: "scripted-acp" }, undefined])
  expect(sessionRowFromSession({ id: "s1" }, ref).harness).toBeUndefined()
})

test("session row: a listed status carries whether the session's harness runs work outside any turn", () => {
  expect(listedStatusFromListItem({ status: { kind: "interrupted", awaitingInput: false, at: 1 } })).toEqual({
    status: { kind: "interrupted" }, waitingOnUser: false, backgroundWork: { agents: 0, shells: 0, other: 0 },
  })
  expect(listedStatusFromListItem({ status: { kind: "idle", awaitingInput: false, backgroundWork: { agents: 2, shells: 0, other: 1 }, at: 1 } })).toEqual({
    status: { kind: "idle" }, waitingOnUser: false, backgroundWork: { agents: 2, shells: 0, other: 1 },
  })
  expect(listedStatusFromListItem({ status: { kind: "busy", awaitingInput: true, at: 1 } })).toEqual({
    status: { kind: "working" }, waitingOnUser: true, backgroundWork: { agents: 0, shells: 0, other: 0 },
  })
})

test("session row: a list item carries its session's last turn as the server recorded it", () => {
  const address = { placementFor: () => ({ placementId: placementId("placement-1"), projectId: projectId("project-1") }) }
  const item = (lastTurn?: unknown) => ({ sessionId: "s1", directory: "/work", createdAt: 1, updatedAt: 2, ...(lastTurn === undefined ? {} : { lastTurn }) })
  expect(sessionRowFromListItem(item({ status: "failed", completedAt: 9 }), address)?.lastTurn).toEqual({ status: "failed", completedAt: 9 })
  expect(sessionRowFromListItem(item(), address)?.lastTurn).toBeUndefined()
  expect(sessionRowFromListItem(item({ status: "busy", completedAt: 9 }), address)?.lastTurn).toBeUndefined()
})
