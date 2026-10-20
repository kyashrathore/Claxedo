import type { BackgroundWork } from "@/server"
import type { SubagentView } from "@/transcript"
import type { SessionSubagent } from "../../transcript/subagent-merge"
import { runsInBackground, subagentViews, type SubagentLabels } from "../subagent-views"

export type BackgroundTasks = {
  readonly running: number
  readonly agents: readonly SubagentView[]
  readonly unlistedAgents: number
  readonly shells: number
  readonly other: number
}


export function backgroundTasks(input: {
  readonly work: BackgroundWork
  readonly subagents: readonly SessionSubagent[]
  readonly sessionId: string
  readonly labels: SubagentLabels
  readonly stops: boolean
}): BackgroundTasks {
  const agents = subagentViews({ entries: input.subagents, parentSessionId: input.sessionId, labels: input.labels, stops: input.stops }).filter(runsInBackground)
  const agentCount = Math.max(input.work.agents, agents.length)
  return {
    running: agentCount + input.work.shells + input.work.other,
    agents,
    unlistedAgents: agentCount - agents.length,
    shells: input.work.shells,
    other: input.work.other,
  }
}
