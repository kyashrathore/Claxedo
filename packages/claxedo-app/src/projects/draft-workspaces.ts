import { placementId, type MachineId, type Placement, type PlacementId, type ProjectId } from "@/server"

export const MAIN_WORKSPACE = "main"

export const CREATE_WORKSPACE = "create"

export type HostKind = "self" | "provisioner"

export type WorkspaceChoice = typeof MAIN_WORKSPACE | typeof CREATE_WORKSPACE | PlacementId

export function workspaceChoice(value: string): WorkspaceChoice {
  return value === MAIN_WORKSPACE || value === CREATE_WORKSPACE ? value : placementId(value)
}

export function environmentOptions(input: { readonly localExecution: boolean; readonly cloud: boolean }): HostKind[] {
  return [...(input.localExecution ? (["self"] as const) : []), ...(input.cloud ? (["provisioner"] as const) : [])]
}

export function hostKindOf(placement: Placement | undefined): HostKind {
  return placement?.kind === "cloud" ? "provisioner" : "self"
}

function onThisMachine(placement: Placement, thisMachine: MachineId | undefined) {
  return placement.machineId === undefined || placement.machineId === thisMachine
}

export function rootPlacement(placements: readonly Placement[], projectId: ProjectId): Placement | undefined {
  return placements.find((placement) => placement.projectId === projectId && placement.kind === "folder")
}

export function workspaceOptions(input: {
  readonly placements: readonly Placement[]
  readonly projectId: ProjectId
  readonly hostKind: HostKind
  readonly thisMachine: MachineId | undefined
}): WorkspaceChoice[] {
  const own = input.placements.filter((placement) => placement.projectId === input.projectId)
  if (input.hostKind === "provisioner") return own.filter((placement) => placement.kind === "cloud").map((placement) => placement.id)
  const local = own.filter((placement) => placement.kind !== "cloud" && onThisMachine(placement, input.thisMachine))
  const main: WorkspaceChoice[] = local.some((placement) => placement.kind === "folder") ? [MAIN_WORKSPACE] : []
  return [...main, ...local.filter((placement) => placement.kind === "worktree").map((placement) => placement.id)]
}

export function initialWorkspace(placements: readonly Placement[], placementId: PlacementId): WorkspaceChoice {
  const placement = placements.find((item) => item.id === placementId)
  return placement?.kind === "folder" ? MAIN_WORKSPACE : placementId
}

export function currentWorkspace(options: readonly WorkspaceChoice[], selected: WorkspaceChoice): WorkspaceChoice | undefined {
  if (selected === CREATE_WORKSPACE) return options[0]
  return options.includes(selected) ? selected : options[0]
}

export function creatingWorkspace(options: readonly WorkspaceChoice[], selected: WorkspaceChoice, hostKind: HostKind): boolean {
  return selected === CREATE_WORKSPACE || (hostKind === "provisioner" && options.length === 0)
}
