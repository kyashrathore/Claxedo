import { unreachable } from "@/lib/machine"
import type { AppError, MachineId, PlacementId, ProjectId, ProjectSource } from "@/server"

export type PlacementChoice =
  | { readonly kind: "cloud" }
  | { readonly kind: "machine"; readonly machineId: MachineId }

export type ProjectDraft = {
  name: string
  source?: ProjectSource
  harnessId?: string
  placement?: PlacementChoice
}

export type AddProjectState =
  | { readonly kind: "choosingSource" }
  | { readonly kind: "choosingAgent" }
  | { readonly kind: "choosingPlacement" }
  | { readonly kind: "creating" }
  | { readonly kind: "created"; readonly projectId: ProjectId; readonly placementId?: PlacementId }
  | { readonly kind: "failed"; readonly error: AppError }

export type AddProjectEvent =
  | { readonly type: "sourceChosen" }
  | { readonly type: "agentChosen" }
  | { readonly type: "back" }
  | { readonly type: "createRequested" }
  | { readonly type: "projectCreated"; readonly projectId: ProjectId; readonly placementId?: PlacementId }
  | { readonly type: "createFailed"; readonly error: AppError }
  | { readonly type: "retryRequested" }

export type AddProjectStep = "source" | "agent" | "placement"

export const addProjectSteps: readonly AddProjectStep[] = ["source", "agent", "placement"]

export const addProjectInitial: AddProjectState = { kind: "choosingSource" }

function stepBack(state: AddProjectState): AddProjectState {
  switch (state.kind) {
    case "choosingAgent":
      return { kind: "choosingSource" }
    case "choosingPlacement":
    case "failed":
      return { kind: "choosingAgent" }
    case "choosingSource":
    case "creating":
    case "created":
      return state
    default:
      return unreachable(state)
  }
}

export function addProjectTransition(state: AddProjectState, event: AddProjectEvent): AddProjectState {
  switch (event.type) {
    case "sourceChosen":
      return state.kind === "choosingSource" ? { kind: "choosingAgent" } : state
    case "agentChosen":
      return state.kind === "choosingAgent" ? { kind: "choosingPlacement" } : state
    case "back":
      return stepBack(state)
    case "createRequested":
      return state.kind === "choosingPlacement" || state.kind === "failed" ? { kind: "creating" } : state
    case "projectCreated":
      return state.kind === "creating"
        ? { kind: "created", projectId: event.projectId, ...(event.placementId ? { placementId: event.placementId } : {}) }
        : state
    case "createFailed":
      return state.kind === "creating" ? { kind: "failed", error: event.error } : state
    case "retryRequested":
      return state.kind === "failed" ? { kind: "choosingPlacement" } : state
    default:
      return unreachable(event)
  }
}

export function addProjectStep(state: AddProjectState): AddProjectStep | "done" {
  switch (state.kind) {
    case "choosingSource":
      return "source"
    case "choosingAgent":
      return "agent"
    case "choosingPlacement":
    case "creating":
    case "failed":
      return "placement"
    case "created":
      return "done"
    default:
      return unreachable(state)
  }
}

function lastSegment(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
}

export function draftProjectName(source: ProjectSource): string {
  switch (source.kind) {
    case "folder":
      return lastSegment(source.path)
    case "repository":
      return lastSegment(source.url).replace(/\.git$/, "")
    case "connectedRepository":
      return lastSegment(source.fullName)
    default:
      return unreachable(source)
  }
}

export function sourceLabel(source: ProjectSource | undefined): string {
  if (!source) return ""
  switch (source.kind) {
    case "folder":
      return source.path
    case "repository":
      return source.url
    case "connectedRepository":
      return source.fullName
    default:
      return unreachable(source)
  }
}
