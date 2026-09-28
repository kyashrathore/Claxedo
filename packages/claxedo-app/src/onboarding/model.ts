import { unreachable } from "@/lib/machine"
import type { PlacementId, Project, ProjectSource } from "@/server"

export type OnboardingDraft = { readonly source: ProjectSource; readonly name?: string }

export type ExecutionChoice = "local" | "cloud" | "connected"

export type ExecutionFacts = { readonly localExecution: boolean; readonly cloudAvailable: boolean }

export type ExecutionBlock = "signIn" | "folder" | "machine"

export function executionChoices(facts: ExecutionFacts): readonly ExecutionChoice[] {
  return [...(facts.localExecution ? (["local"] as const) : []), ...(facts.cloudAvailable ? (["cloud"] as const) : []), "connected"]
}

export function executionBlock(choice: ExecutionChoice, facts: ExecutionFacts, source: ProjectSource | undefined): ExecutionBlock | undefined {
  if (choice !== "cloud") return facts.localExecution ? undefined : "machine"
  if (!facts.cloudAvailable) return "signIn"
  return source?.kind === "folder" ? "folder" : undefined
}

export type Created =
  | { readonly kind: "project"; readonly project: Project }
  | { readonly kind: "cloudProject"; readonly project: Project }
  | { readonly kind: "workspace"; readonly placementId: PlacementId }

export type Openable = Extract<Created, { readonly kind: "project" | "workspace" }>

export function openable(created: Created | undefined): created is Openable {
  return created?.kind === "project" || created?.kind === "workspace"
}

export type FinishState =
  | { readonly kind: "ready" }
  | { readonly kind: "working"; readonly created?: Created }
  | { readonly kind: "failed"; readonly error: string; readonly created?: Created }
  | { readonly kind: "finished"; readonly created: Openable }

export type FinishEvent =
  | { readonly type: "started" }
  | { readonly type: "created"; readonly created: Created }
  | { readonly type: "failed"; readonly error: string }
  | { readonly type: "opened" }
  | { readonly type: "moved" }

export function createdOf(state: FinishState): Created | undefined {
  return state.kind === "ready" ? undefined : state.created
}

function kept(created: Created | undefined) {
  return created ? { created } : {}
}

export function finishTransition(state: FinishState, event: FinishEvent): FinishState {
  switch (event.type) {
    case "started":
      return state.kind === "ready" || state.kind === "failed" ? { kind: "working", ...kept(createdOf(state)) } : state
    case "created":
      return state.kind === "working" ? { kind: "working", created: event.created } : state
    case "failed":
      return state.kind === "working" ? { kind: "failed", error: event.error, ...kept(state.created) } : state
    case "opened":
      return state.kind === "working" && openable(state.created) ? { kind: "finished", created: state.created } : state
    case "moved":
      return state.kind === "failed" && !state.created ? { kind: "ready" } : state
    default:
      return unreachable(event)
  }
}
