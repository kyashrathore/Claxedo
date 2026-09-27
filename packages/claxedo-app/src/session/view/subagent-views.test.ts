/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { SessionSubagent } from "@/session"
import { subagentViews } from "./subagent-views"

const labels = { subagent: "Subagent", task: "Task" }
const spawned: SessionSubagent = { subagentKey: "spawned", toolCallEdges: new Map([["call_1", "spawn"]]), revisions: {} }
const unhosted: SessionSubagent = { subagentKey: "unhosted", toolCallEdges: new Map(), revisions: {} }

test("a subagent with a spawning call stays out of Background while its turn is unloaded, and renders in that turn once it loads", () => {
  const views = (toolCallId?: string) => subagentViews({ entries: [spawned], parentSessionId: "ses_1", labels, toolCallId })
  expect(views().filter((view) => view.ambient)).toEqual([])
  expect(views("call_1").map((view) => [view.subagentKey, view.toolCallRole, view.ambient])).toEqual([["spawned", "spawn", false]])
  expect(views("call_2")).toEqual([])
})

test("a subagent with no tool call edge is in Background", () => {
  const views = subagentViews({ entries: [spawned, unhosted], parentSessionId: "ses_1", labels })
  expect(views.filter((view) => view.ambient).map((view) => view.subagentKey)).toEqual(["unhosted"])
})
