import type { MachineId, Placement, PlacementId, ProjectId } from "@/server"

export type WherePlace = "computer" | "cloud" | "machine"

export type WhereEntry =
  | { readonly kind: "placement"; readonly place: WherePlace; readonly placement: Placement }
  | { readonly kind: "connectComputer" }

export type WhereChoice =
  | { readonly kind: "placement"; readonly id: PlacementId }
  | { readonly kind: "newWorktree" }
  | { readonly kind: "newCloud"; readonly name: string }

export type WhereCreation = "worktree" | "cloud"

export type WhereFacts = {
  readonly placements: readonly Placement[]
  readonly projectId: ProjectId
  readonly thisMachine: MachineId | undefined
  readonly machineConnected: boolean | undefined
}

const PLACE_ORDER: readonly WherePlace[] = ["computer", "cloud", "machine"]

export function placeOf(placement: Placement, thisMachine: MachineId | undefined): WherePlace {
  if (placement.kind === "cloud") return "cloud"
  if (thisMachine === undefined) return "machine"
  return placement.machineId === undefined || placement.machineId === thisMachine ? "computer" : "machine"
}

function byPlaceThenFolder(facts: WhereFacts) {
  return (left: Placement, right: Placement) => {
    const place = PLACE_ORDER.indexOf(placeOf(left, facts.thisMachine)) - PLACE_ORDER.indexOf(placeOf(right, facts.thisMachine))
    return place !== 0 ? place : Number(left.kind !== "folder") - Number(right.kind !== "folder")
  }
}

export function whereEntries(facts: WhereFacts): readonly WhereEntry[] {
  const own = facts.placements.filter((placement) => placement.projectId === facts.projectId).toSorted(byPlaceThenFolder(facts))
  const placed = own.map((placement): WhereEntry => ({ kind: "placement", place: placeOf(placement, facts.thisMachine), placement }))
  const connect: readonly WhereEntry[] = facts.thisMachine === undefined && facts.machineConnected === false ? [{ kind: "connectComputer" }] : []
  return [...connect, ...placed]
}

export function entryPlace(entry: WhereEntry): WherePlace {
  return entry.kind === "connectComputer" ? "computer" : entry.place
}

export function groupedPlaces(entries: readonly WhereEntry[]): ReadonlySet<WherePlace> {
  const places = new Set(entries.map(entryPlace))
  return places.size > 1 ? places : new Set()
}

export function localRoot(entries: readonly WhereEntry[]): Placement | undefined {
  for (const entry of entries) if (entry.kind === "placement" && entry.place === "computer" && entry.placement.kind === "folder") return entry.placement
  return undefined
}

export function currentPlacement(entries: readonly WhereEntry[], choice: WhereChoice): Placement | undefined {
  const placements = entries.flatMap((entry) => (entry.kind === "placement" ? [entry.placement] : []))
  const chosen = choice.kind === "placement" ? placements.find((placement) => placement.id === choice.id) : undefined
  return chosen ?? placements[0]
}

export function creationOf(choice: WhereChoice): WhereCreation | undefined {
  if (choice.kind === "newWorktree") return "worktree"
  return choice.kind === "newCloud" ? "cloud" : undefined
}

export function newCloudName(value: string): WhereChoice | undefined {
  const name = value.trim()
  return name ? { kind: "newCloud", name } : undefined
}
