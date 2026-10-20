/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { SessionSubagent } from "@/session"
import { backgroundTasks } from "./background"

const labels = { subagent: "Subagent", task: "Task" }
const agent = (key: string, status: SessionSubagent["status"], mode: SessionSubagent["mode"] = "background"): SessionSubagent => ({
  subagentKey: key,
  mode,
  status,
  label: key,
  toolCallEdges: new Map([[`call_${key}`, "spawn"]]),
  revisions: {},
})

test("the card lists only running background agents, each stoppable by its spawning call while the harness offers it", () => {
  const tasks = backgroundTasks({
    work: { agents: 2, shells: 1, other: 0 },
    subagents: [agent("survey", "running"), agent("lint", "pending"), agent("done", "completed"), agent("inline", "running", "foreground")],
    sessionId: "ses_1",
    labels,
    stops: true,
  })
  expect(tasks.agents.map((view) => [view.label, view.stopCall])).toEqual([
    ["survey", "call_survey"],
    ["lint", "call_lint"],
  ])
  expect([tasks.running, tasks.unlistedAgents, tasks.shells, tasks.other]).toEqual([3, 0, 1, 0])
})

test("agents the counts report before their rows arrive are counted, not dropped, and listed rows never count twice", () => {
  const early = backgroundTasks({ work: { agents: 2, shells: 0, other: 1 }, subagents: [], sessionId: "ses_1", labels, stops: false })
  expect([early.running, early.unlistedAgents, early.agents.length]).toEqual([3, 2, 0])
  const late = backgroundTasks({ work: { agents: 0, shells: 0, other: 0 }, subagents: [agent("survey", "running")], sessionId: "ses_1", labels, stops: false })
  expect([late.running, late.unlistedAgents, late.agents[0]?.stopCall]).toEqual([1, 0, undefined])
})
