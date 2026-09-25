import type { MachineId } from "./ids"
import type { Placement } from "./types"

export function isStoppedCloud(placement: Placement | undefined): boolean {
  return placement?.kind === "cloud" && !placement.reachable
}

export function isOfflineMachine(placement: Placement | undefined, thisMachine: MachineId | undefined): boolean {
  return !!placement && placement.kind !== "cloud" && !placement.reachable && placement.machineId !== undefined && placement.machineId !== thisMachine
}
