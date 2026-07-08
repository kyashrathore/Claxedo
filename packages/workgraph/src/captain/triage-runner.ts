import type { WorkGraph } from "../model/workgraph"
import type { IntakeItem } from "../model/types"
import { resolveRegisteredLoadout } from "../model/loadout-registry"
import { tool } from "../sdk/prompts"
import type { CaptainRunResult } from "./runner"
import { runCaptain } from "./runner"

export interface TriageRuntime {
  spawn(input: {
    intake: IntakeItem
    workItemId: string
    agentRunId: string
    prompt: string
    loadout: NonNullable<ReturnType<WorkGraph["resolveLoadoutSlot"]>>
    visible: true
    workGraph: WorkGraph
  }): Promise<{ sessionId: string; agentRunId: string }>
}

export interface TriageRunResult {
  status: "triaged"
  sessionId: string
  agentRunId: string
  captain: CaptainRunResult
}

export async function runTriage(
  workGraph: WorkGraph,
  intakeItemId: string,
  runtime: TriageRuntime,
  opts: {
    runCaptain?: (workGraph: WorkGraph, agentRunId: string) => Promise<CaptainRunResult>
  } = {},
): Promise<TriageRunResult | { status: "skipped"; mode: "off" }> {
  const intake = workGraph.getIntakeItem(intakeItemId)
  if (!intake) throw new Error(`IntakeItem '${intakeItemId}' not found`)
  const loadout = intake.triageModeOverride
    ? {
        source: "slot" as const,
        slotId: null,
        scopeType: "intake_item" as const,
        scopeId: intake.id,
        kind: "triage_mode" as const,
        ...resolveRegisteredLoadout("triage_mode", { name: intake.triageModeOverride }, { type: "intake_item", intake }),
      }
    : workGraph.resolveLoadoutSlot({ type: "intake_item", id: intake.id }, "triage_mode")
  if (!loadout) throw new Error("Unable to resolve triage mode")
  if (loadout.name === "off") return { status: "skipped", mode: "off" }

  const agentRunId = crypto.randomUUID()
  workGraph.updateIntakeItem(intake.id, { status: "triaging" })
  let agent: Awaited<ReturnType<TriageRuntime["spawn"]>> | undefined
  try {
    agent = await runtime.spawn({
      intake,
      workItemId: intake.id,
      agentRunId,
      prompt: buildTriagePrompt(intake, loadout, agentRunId),
      loadout,
      visible: true,
      workGraph,
    })
    workGraph.updateIntakeItem(intake.id, {
      status: "triaging",
      linkedSessionId: agent.sessionId,
    })
    const captain = await (opts.runCaptain ?? defaultRunCaptain)(workGraph, agent.agentRunId)
    const scratchpad = workGraph.getLatestScratchpadByRun(agent.agentRunId)
    if (!scratchpad || scratchpad.kind !== "triage") {
      throw new Error(`Triage session '${agent.sessionId}' completed without writing a triage scratchpad`)
    }
    workGraph.updateIntakeItem(intake.id, {
      status: "triaged",
      linkedSessionId: agent.sessionId,
      lastTriagedAt: new Date().toISOString(),
    })

    return {
      status: "triaged",
      sessionId: agent.sessionId,
      agentRunId: agent.agentRunId,
      captain,
    }
  } catch (err) {
    workGraph.updateIntakeItem(intake.id, {
      status: "captured",
      ...(agent?.sessionId ? { linkedSessionId: agent.sessionId } : {}),
    })
    workGraph.appendIntakeActivity(intake.id, {
      kind: "triage_failed",
      actor: "system",
      payload: {
        agentRunId,
        ...(agent?.sessionId ? { sessionId: agent.sessionId } : {}),
        error: err instanceof Error ? err.message : String(err),
      },
    })
    throw err
  }
}

export function createTriageDebouncer(
  run: (intakeItemId: string) => Promise<void>,
  delayMs = 100,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    schedule(intakeItemId: string) {
      const existing = timers.get(intakeItemId)
      if (existing) clearTimeout(existing)
      timers.set(intakeItemId, setTimeout(() => {
        timers.delete(intakeItemId)
        run(intakeItemId)
      }, delayMs))
    },
    pendingCount() {
      return timers.size
    },
  }
}

async function defaultRunCaptain(workGraph: WorkGraph, agentRunId: string) {
  return runCaptain(workGraph, agentRunId, {
    run: async () => ({ sessionId: null }),
  })
}

function buildTriagePrompt(
  intake: IntakeItem,
  loadout: NonNullable<ReturnType<WorkGraph["resolveLoadoutSlot"]>>,
  agentRunId: string,
) {
  return [
    loadout.payload.promptTemplate,
    "",
    "Use these MCP tools exactly by name:",
    `- ${tool.write}`,
    "",
    `For the scratchpad call, include run_id = ${agentRunId}, subject_type = intake_item, subject_id = ${intake.id}, agent_run_id = ${agentRunId}, and kind = triage.`,
    "Write exactly one concise triage scratchpad before finishing. Do not call update_status; intake triage completion is tracked by the scratchpad.",
    "",
    `IntakeItem: ${intake.id}`,
    intake.bodyMd,
  ].join("\n")
}
