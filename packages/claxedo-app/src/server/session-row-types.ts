import type { AgentTurnOutcome, ExecutionAvailability } from "@claxedo/agent-runtime-contract"
import type { HarnessSelection } from "../lib/harness-selection"
import type { MachineId, SessionId } from "./ids"
import type { ModelChoice, SessionLocation } from "./types"

export type SessionSelections = {
  readonly harness?: HarnessSelection
  readonly model?: ModelChoice
  readonly permissionMode?: string
  readonly permissionModeLabel?: string
}

export type SessionPlacementDisplay = {
  readonly kind: "local" | "machine" | "cloud"
  readonly machineId?: MachineId
  readonly machineName?: string
  readonly cloudName?: string
}

export type SessionRow = SessionSelections & {
  readonly ownership?: "owned" | "shared"
  readonly executionAvailability?: ExecutionAvailability
  readonly projectName?: string
  readonly placement?: SessionPlacementDisplay
  readonly attention?: import("@claxedo/agent-runtime-contract").SessionAttentionFacts
  readonly reader?: import("@claxedo/agent-runtime-contract").SessionReaderState
  readonly ref: SessionLocation
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastHumanTurnAt?: number
  readonly archivedAt?: number
  readonly parentSessionId?: SessionId
  readonly lastTurn?: AgentTurnOutcome
}
