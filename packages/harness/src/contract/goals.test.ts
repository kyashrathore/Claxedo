import { expect, test } from "bun:test"
import { goalSnapshotFromRecord } from "./goals"

const invalid = () => new Error("invalid goal")

test("goal snapshots retain valid optional values and reject unknown statuses", () => {
  const row = { objective: "Ship", status: "active" as const, createdAt: 10, updatedAt: 11,
    iteration: 2, lastReason: "resumed", tokenBudget: 100, tokensUsed: 5, timeUsedSeconds: 3 }
  expect(goalSnapshotFromRecord("session", row, { invalid })).toEqual({ sessionId: "session", ...row })
  expect(() => goalSnapshotFromRecord("session", { ...row, status: "usageLimited" }, { invalid })).toThrow("invalid goal")
  expect(() => goalSnapshotFromRecord("session", { ...row, createdAt: undefined }, { invalid })).toThrow("invalid goal")
})

test("Codex status mapping and missing timestamps use one supplied clock value", () => {
  const goal = goalSnapshotFromRecord("session", { objective: "Ship", status: "budgetLimited" }, {
    invalid, now: 42, status: (status) => status === "budgetLimited" ? "limited" : status,
  })
  expect(goal).toEqual({ sessionId: "session", objective: "Ship", status: "limited", createdAt: 42, updatedAt: 42 })
})
