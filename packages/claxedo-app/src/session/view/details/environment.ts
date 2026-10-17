import { machineOfPlacement, type CloudLifecycle, type GitStatus, type Machine, type Placement } from "@/server"

export type MachineState = "online" | "offline" | "paused"

export type EnvironmentWhere =
  | { readonly kind: "thisComputer" }
  | { readonly kind: "machine"; readonly name: string | undefined; readonly state: MachineState }
  | { readonly kind: "cloud"; readonly name: string | undefined; readonly lifecycle: CloudLifecycle }

export type EnvironmentBranch =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "detached" }
  | { readonly kind: "unknown" }

export type BranchRead =
  | { readonly kind: "skipped" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: GitStatus }
  | { readonly kind: "failed" }

export type SessionEnvironment = {
  readonly where: EnvironmentWhere
  readonly worktree: boolean
  readonly folder: string
  readonly path: string | undefined
  readonly branch: EnvironmentBranch
}

function machineState(machine: Machine | undefined, placement: Placement): MachineState {
  if (machine?.paused) return "paused"
  return (machine ? machine.online : placement.reachable) ? "online" : "offline"
}

function whereOf(placement: Placement, machines: readonly Machine[]): EnvironmentWhere {
  if (placement.kind === "cloud") return { kind: "cloud", name: placement.label, lifecycle: placement.lifecycle }
  if (placement.onThisMachine) return { kind: "thisComputer" }
  const machine = machineOfPlacement(machines, placement)
  return { kind: "machine", name: machine?.name, state: machineState(machine, placement) }
}

export function readsBranch(placement: Placement): boolean {
  return placement.reachable
}

function branchOf(placement: Placement, read: BranchRead): EnvironmentBranch {
  if (read.kind === "ready") return read.status.branch ? { kind: "named", name: read.status.branch } : { kind: "detached" }
  return placement.branch ? { kind: "named", name: placement.branch } : { kind: "unknown" }
}

export function sessionEnvironment(input: {
  readonly placement: Placement
  readonly machines: readonly Machine[]
  readonly projectName: string | undefined
  readonly branch: BranchRead
}): SessionEnvironment {
  const { placement } = input
  return {
    where: whereOf(placement, input.machines),
    worktree: placement.kind === "worktree",
    folder: placement.kind === "worktree" ? placement.label : (input.projectName ?? placement.label ?? ""),
    path: placement.path,
    branch: branchOf(placement, input.branch),
  }
}
