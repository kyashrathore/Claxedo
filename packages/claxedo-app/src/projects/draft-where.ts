import type { Placement, PlacementId, ProjectId } from "@/server"

export type WherePlace = "machine" | "cloud"

export type WhereEntry = { readonly place: WherePlace; readonly placement: Placement }

export type WhereChoice =
  | { readonly kind: "placement"; readonly id: PlacementId; readonly pendingName?: string }
  | { readonly kind: "newWorktree"; readonly root: PlacementId }
  | { readonly kind: "newCloud"; readonly name: string; readonly branch?: string }

export type WhereNew = Exclude<WhereChoice, { readonly kind: "placement" }>

export type WhereCreation = "worktree" | "cloud"

export type WhereFacts = {
  readonly placements: readonly Placement[]
  readonly projectId: ProjectId
}

export function placeOf(placement: Placement): WherePlace {
  return placement.kind === "cloud" ? "cloud" : "machine"
}

function rank(placement: Placement): number {
  if (placement.kind === "cloud") return 4
  return (placement.onThisMachine ? 0 : 2) + (placement.kind === "folder" ? 0 : 1)
}

export function whereEntries(facts: WhereFacts): readonly WhereEntry[] {
  return facts.placements
    .filter((placement) => placement.projectId === facts.projectId)
    .toSorted((left, right) => rank(left) - rank(right))
    .map((placement) => ({ place: placeOf(placement), placement }))
}

export function groupedPlaces(entries: readonly WhereEntry[]): ReadonlySet<WherePlace> {
  const places = new Set(entries.map((entry) => entry.place))
  return places.size > 1 ? places : new Set()
}

export function worktreeRoots(entries: readonly WhereEntry[]): readonly Placement[] {
  return entries.flatMap((entry) => (entry.placement.kind === "folder" && entry.placement.onThisMachine ? [entry.placement] : []))
}

export function currentPlacement(entries: readonly WhereEntry[], choice: WhereChoice): Placement | undefined {
  if (choice.kind !== "placement") return undefined
  return entries.find((entry) => entry.placement.id === choice.id)?.placement
}

export function creationOf(choice: WhereChoice): WhereCreation | undefined {
  if (choice.kind === "newWorktree") return "worktree"
  return choice.kind === "newCloud" ? "cloud" : undefined
}

export function newCloudChoice(name: string, branch: string): WhereChoice | undefined {
  const named = name.trim()
  const from = branch.trim()
  return named ? { kind: "newCloud", name: named, ...(from ? { branch: from } : {}) } : undefined
}
