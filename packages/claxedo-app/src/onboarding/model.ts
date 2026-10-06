import type { MachineClass, PlacementId, Project, ProjectSource } from "@/server"

export type OnboardingDraft = { readonly source: ProjectSource; readonly name?: string }

export type ExecutionChoice = "local" | "cloud"

export type ExecutionPlan = { readonly kind: "local" } | { readonly kind: "cloud"; readonly name: string; readonly machineClass?: MachineClass }

export type ExecutionFacts = {
  readonly localExecution: boolean
  readonly machineName: string | undefined
  readonly cloudAvailable: boolean
  readonly machineConnected: boolean | undefined
}

export type ExecutionBlock = "signIn" | "folder"

export function executionChoices(facts: ExecutionFacts): readonly ExecutionChoice[] {
  return [...(facts.localExecution ? (["local"] as const) : []), ...(facts.cloudAvailable ? (["cloud"] as const) : [])]
}

export function offersConnectMachine(facts: ExecutionFacts): boolean {
  return !facts.localExecution && facts.machineConnected === false
}

export function executionPlan(choice: ExecutionChoice, name: string, machineClass: MachineClass | undefined): ExecutionPlan {
  return choice === "cloud" ? { kind: "cloud", name, ...(machineClass ? { machineClass } : {}) } : { kind: "local" }
}

export function executionBlock(plan: ExecutionPlan, facts: ExecutionFacts, source: ProjectSource | undefined): ExecutionBlock | undefined {
  if (plan.kind === "local") return undefined
  if (!facts.cloudAvailable) return "signIn"
  return source?.kind === "folder" ? "folder" : undefined
}

export type Created =
  | { readonly kind: "project"; readonly project: Project }
  | { readonly kind: "workspace"; readonly placementId: PlacementId }
