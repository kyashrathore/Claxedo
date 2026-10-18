import { readField, readFiniteNumber, readString } from "@claxedo/helpers/readers"
import type { RunningApp } from "./running-app"
import type { Activation } from "./settle"

const SWITCH_WORKLOADS = ["list-walk", "progressive-resource", "resource-control"] as const
const SESSION_STATES = ["cold", "warm"] as const

export type SwitchCase = {
  caseId: string
  workload: (typeof SWITCH_WORKLOADS)[number]
  sessionState?: (typeof SESSION_STATES)[number]
  walkPosition?: number
  sourceSessionId?: string
  destinationSessionId: string
}

export function readSwitchCase(value: unknown): SwitchCase {
  const caseId = readString(value, "caseId")
  const workload = SWITCH_WORKLOADS.find((candidate) => candidate === readField(value, "workload"))
  const destinationSessionId = readString(value, "destinationSessionId")
  if (caseId === undefined || workload === undefined || destinationSessionId === undefined) {
    throw new Error(`Claxedo received a malformed session-switch case: ${JSON.stringify(value)}`)
  }
  return {
    caseId,
    workload,
    sessionState: SESSION_STATES.find((candidate) => candidate === readField(value, "sessionState")),
    walkPosition: readFiniteNumber(value, "walkPosition"),
    sourceSessionId: readString(value, "sourceSessionId"),
    destinationSessionId,
  }
}

async function requireVisitState(app: RunningApp, benchmarkCase: SwitchCase) {
  const destination = app.target(benchmarkCase.destinationSessionId)
  const visited = app.wasDisplayed(destination)
  if ((benchmarkCase.sessionState === "cold") === visited) {
    throw new Error(`Claxedo ${String(benchmarkCase.sessionState)} step to ${destination.logicalSessionId} does not match this process's visits`)
  }
  if (benchmarkCase.sessionState === "cold" && (await app.hasMountedScreen(destination))) {
    throw new Error(`Claxedo already holds a session screen for cold destination ${destination.logicalSessionId}`)
  }
}

export async function executeListWalkStep(app: RunningApp, benchmarkCase: SwitchCase): Promise<Activation> {
  const destination = app.target(benchmarkCase.destinationSessionId)
  const source = app.target(benchmarkCase.sourceSessionId ?? "control")
  await requireVisitState(app, benchmarkCase)
  const measured = await app.activate(destination)
  if (benchmarkCase.walkPosition !== 0) await app.requireNextRowDown(source, destination)
  return measured
}

export async function executeResourceStep(app: RunningApp, benchmarkCase: SwitchCase): Promise<Activation> {
  const destination = app.target(benchmarkCase.destinationSessionId)
  if (benchmarkCase.workload === "resource-control") return app.activate(destination)
  await requireVisitState(app, benchmarkCase)
  const control = app.target(benchmarkCase.sourceSessionId ?? "control")
  if (!(await app.isShowing(control))) await app.activate(control)
  return app.activate(destination)
}
