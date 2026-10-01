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

test("a running background subagent can be stopped by its spawning call while the harness offers it, and never once it settles", () => {
  const background = (status: SessionSubagent["status"]): SessionSubagent => ({ ...spawned, mode: "background", status })
  const stopCall = (entry: SessionSubagent, stops: boolean) => subagentViews({ entries: [entry], parentSessionId: "ses_1", labels, stops })[0]?.stopCall
  expect(stopCall(background("running"), true)).toBe("call_1")
  expect(stopCall(background("pending"), true)).toBe("call_1")
  expect(stopCall(background("running"), false)).toBeUndefined()
  expect(stopCall(background("killed"), true)).toBeUndefined()
  expect(stopCall({ ...spawned, mode: "foreground", status: "running" }, true)).toBeUndefined()
  expect(stopCall({ ...unhosted, mode: "background", status: "running" }, true)).toBeUndefined()
})
