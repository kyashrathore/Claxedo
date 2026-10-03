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
  | { readonly kind: "workspace"; readonly placementId: PlacementId }
