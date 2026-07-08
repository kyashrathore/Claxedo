import type { WorkGraph } from "../model/workgraph"
import type { ScratchpadEntry, WorkEvent } from "../model/types"
import { tool } from "../sdk/prompts"

export interface CaptainRuntime {
  run(input: {
    agentRunId: string
    scratchpad: ScratchpadEntry
    prompt: string
    toolsRole: "captain"
    workGraph: WorkGraph
  }): Promise<{ sessionId?: string | null }>
}

export interface CaptainRunResult {
  sessionId?: string | null
  scratchpad: ScratchpadEntry
  events: WorkEvent[]
}

export async function runCaptain(
  workGraph: WorkGraph,
  agentRunId: string,
  runtime: CaptainRuntime,
): Promise<CaptainRunResult> {
  const scratchpad = workGraph.getLatestScratchpadByRun(agentRunId)
  if (!scratchpad) throw new Error(`Scratchpad for agent run '${agentRunId}' not found`)
  const beforeSeq = workGraph.getEvents().at(-1)?.seq ?? 0

  try {
    const result = await runtime.run({
      agentRunId,
      scratchpad,
      prompt: buildCaptainPrompt(agentRunId, scratchpad),
      toolsRole: "captain",
      workGraph,
    })
    return {
      sessionId: result.sessionId ?? null,
      scratchpad,
      events: workGraph.getEvents().filter((event) => event.seq > beforeSeq),
    }
  } catch (error) {
    workGraph.recordCaptainFailure({
      agentRunId,
      scratchpadId: scratchpad.id,
      errorClass: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

function buildCaptainPrompt(agentRunId: string, scratchpad: ScratchpadEntry) {
  return [
    `Agent run: ${agentRunId}`,
    "Read the scratchpad and call Captain proposal tools for graph changes.",
    "Use these MCP tools exactly by name:",
    `- ${tool.create}`,
    `- ${tool.validate}`,
    "",
    `For every MCP call, include run_id = ${agentRunId}.`,
    "Use ReviewableDecisions for genuine ambiguity by setting proposal confidence below 0.8. Do not mutate graph state without a tool call.",
    "",
    scratchpad.content,
  ].join("\n")
}
