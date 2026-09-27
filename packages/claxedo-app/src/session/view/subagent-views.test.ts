/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { SessionSubagent } from "@/session"
import { subagentViews } from "./subagent-views"

const labels = { subagent: "Subagent", task: "Task" }
const spawned: SessionSubagent = { subagentKey: "spawned", toolCallEdges: new Map([["call_1", "spawn"]]), revisions: {} }
const unhosted: SessionSubagent = { subagentKey: "unhosted", toolCallEdges: new Map(), revisions: {} }

function ambientKeys(hostableCallIds: ReadonlySet<string>, historyComplete: boolean) {
  return subagentViews({ entries: [spawned, unhosted], parentSessionId: "ses_1", labels, hostableCallIds, historyComplete })
    .filter((view) => view.ambient)
    .map((view) => view.subagentKey)
}

test("a subagent whose spawning call is on a page not yet loaded waits for its turn instead of floating above the latest one", () => {
  expect(ambientKeys(new Set(), false)).toEqual(["unhosted"])
})

test("with the whole history loaded, a subagent whose spawning call is nowhere in it is ambient", () => {
  expect(ambientKeys(new Set(), true)).toEqual(["spawned", "unhosted"])
})

test("a subagent whose spawning call is loaded renders in its turn", () => {
  expect(ambientKeys(new Set(["call_1"]), false)).toEqual(["unhosted"])
  expect(ambientKeys(new Set(["call_1"]), true)).toEqual(["unhosted"])
})

test("a subagent with a spawning call stays out of Background while its turn is unloaded, however much of the history is known, and renders in that turn once it loads", () => {
  const views = (hostableCallIds: ReadonlySet<string>, toolCallId?: string) =>
    subagentViews({ entries: [spawned], parentSessionId: "ses_1", labels, hostableCallIds, historyComplete: true, toolCallId })
  expect(views(new Set()).filter((view) => view.ambient)).toEqual([])
  expect(views(new Set(["call_1"]), "call_1").map((view) => [view.subagentKey, view.toolCallRole, view.ambient])).toEqual([["spawned", "spawn", false]])
})

test("a subagent with no tool call edge is in Background whether or not older history is loaded", () => {
  expect(ambientKeys(new Set(), false)).toContain("unhosted")
  expect(ambientKeys(new Set(), true)).toContain("unhosted")
})

