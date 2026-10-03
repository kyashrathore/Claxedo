/// <reference types="bun" />
import { expect, test } from "bun:test"
import { machineId, placementId, projectId, sessionId, type SessionRow } from "@/server"
import { newerRow } from "./row-version"

const row: SessionRow = {
  ref: { projectId: projectId("p"), placementId: placementId("w"), sessionId: sessionId("s") },
  title: "Result", createdAt: 1, updatedAt: 20,
  projectName: "Shared project", placement: { kind: "machine", machineId: machineId("m"), machineName: "Alice's Mac" },
  attention: { generation: 1, sequence: 10, activitySequence: 10, activityAt: 20, working: false, awaitingInput: false, outcome: { sequence: 10, status: "completed", completedAt: 20 } },
  lastTurn: { status: "completed", completedAt: 20, assistantMessageId: "answer" },
}

test("opening a runtime session preserves inventory project and placement metadata until an authoritative clear", () => {
  const { projectName: _project, placement: _placement, ...runtime } = row
  const next = newerRow(row, { ...runtime, title: "Updated", updatedAt: 21 })!
  expect(next.projectName).toBe("Shared project")
  expect(next.placement).toEqual(row.placement)
  const revoked = newerRow(next, { ...next, placement: { kind: "machine" }, projectName: undefined })!
  expect(revoked.projectName).toBeUndefined()
  expect(revoked.placement?.machineName).toBeUndefined()
})

test("stale metadata cannot separate the latest attention position from its exact reply identity", () => {
  const latest = { ...row, attention: { ...row.attention!, sequence: 30, activitySequence: 30, activityAt: 30, outcome: { sequence: 30, status: "completed" as const, completedAt: 30 } }, lastTurn: { status: "completed" as const, completedAt: 30, assistantMessageId: "new-answer" } }
  for (const updatedAt of [19, 20, 40]) {
    const next = newerRow(latest, { ...row, title: "Renamed", updatedAt }) ?? latest
    expect(next.attention).toEqual(latest.attention)
    expect(next.lastTurn).toEqual(latest.lastTurn)
    expect(next.title).toBe(updatedAt < 20 ? "Result" : "Renamed")
  }
  const outcomeBeforeMetadata = newerRow(row, { ...latest, updatedAt: 19 })!
  expect(outcomeBeforeMetadata.lastTurn).toEqual(latest.lastTurn)
  expect(outcomeBeforeMetadata.updatedAt).toBe(20)
})

test("a new generation without an outcome never borrows an earlier generation's reply", () => {
  const next = newerRow(row, { ...row, attention: { ...row.attention!, generation: 50, sequence: 50, activitySequence: 50, outcome: undefined }, lastTurn: undefined })!
  expect(next.attention?.generation).toBe(50)
  expect(next.lastTurn).toBeUndefined()
})


test("a stale inventory reader cannot undo explicit settlement", () => {
  const reader = { generation: 1, revision: 2, seenThrough: 10, seenAt: 30, settledThrough: 10, settledAt: 30 }
  const current = { ...row, reader }
  const stale = newerRow(current, { ...row, updatedAt: 21, reader: { generation: 1, revision: 1, seenThrough: 10, seenAt: 29 } })!
  expect(stale.reader).toEqual(reader)
})
