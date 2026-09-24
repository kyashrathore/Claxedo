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
  | { readonly kind: "choosingPlacement"; readonly projectId?: ProjectId }
  | { readonly kind: "creating"; readonly projectId?: ProjectId }
  | { readonly kind: "created"; readonly projectId: ProjectId; readonly placementId?: PlacementId }
  | { readonly kind: "failed"; readonly error: AppError; readonly projectId?: ProjectId }

export type AddProjectEvent =
  | { readonly type: "sourceChosen" }
  | { readonly type: "agentChosen" }
  | { readonly type: "back" }
  | { readonly type: "createRequested" }
  | { readonly type: "projectRecorded"; readonly projectId: ProjectId }
  | { readonly type: "projectCreated"; readonly projectId: ProjectId; readonly placementId?: PlacementId }
  | { readonly type: "createFailed"; readonly error: AppError }

export type AddProjectStep = "source" | "agent" | "placement"

export const addProjectSteps: readonly AddProjectStep[] = ["source", "agent", "placement"]

export const addProjectInitial: AddProjectState = { kind: "choosingSource" }

function recorded(projectId: ProjectId | undefined): { readonly projectId?: ProjectId } {
  return projectId ? { projectId } : {}
}

function stepBack(state: AddProjectState): AddProjectState {
  switch (state.kind) {
    case "choosingAgent":
      return { kind: "choosingSource" }
    case "choosingPlacement":
      return state.projectId ? state : { kind: "choosingAgent" }
    case "failed":
      return state.projectId ? { kind: "choosingPlacement", projectId: state.projectId } : { kind: "choosingAgent" }
    case "choosingSource":
    case "creating":
    case "created":
      return state
    default:
      return unreachable(state)
  }
}

export function canGoBack(state: AddProjectState): boolean {
  return stepBack(state) !== state
}

export function recordedProjectId(state: AddProjectState): ProjectId | undefined {
  return state.kind === "choosingPlacement" || state.kind === "creating" || state.kind === "failed" ? state.projectId : undefined
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
      return state.kind === "choosingPlacement" || state.kind === "failed" ? { kind: "creating", ...recorded(state.projectId) } : state
    case "projectRecorded":
      return state.kind === "creating" ? { kind: "creating", projectId: event.projectId } : state
    case "projectCreated":
      return state.kind === "creating"
        ? { kind: "created", projectId: event.projectId, ...(event.placementId ? { placementId: event.placementId } : {}) }
        : state
    case "createFailed":
      return state.kind === "creating" ? { kind: "failed", error: event.error, ...recorded(state.projectId) } : state
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
