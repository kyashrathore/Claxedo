import type { WorkspaceRuntime } from "./cloud-types"
import type { Machine, Placement } from "./types"

export function isStoppedCloud(placement: Placement | undefined): boolean {
  return placement?.kind === "cloud" && !placement.reachable
}

export function isStartingCloud(placement: Placement | undefined): boolean {
  return placement?.kind === "cloud" && placement.lifecycle === "starting"
}

export function isFreshStart(runtime: Extract<WorkspaceRuntime, { kind: "waking" }>): boolean {
  return runtime.bootMode === "cold-start" || (runtime.bootMode === undefined && runtime.followed === true)
}

export function isOfflineMachine(placement: Placement | undefined): boolean {
  return !!placement && placement.kind !== "cloud" && !placement.onThisMachine && !placement.reachable && placement.machineId !== undefined
}

export function isLocalPlacement(placement: Placement | undefined): boolean {
  return !!placement && placement.kind !== "cloud" && placement.onThisMachine
}

export function machineOfPlacement(machines: readonly Machine[], placement: Placement): Machine | undefined {
  if (placement.kind === "cloud") return undefined
  if (placement.onThisMachine) return machines.find((machine) => machine.isThisMachine)
  return machines.find((machine) => machine.id !== undefined && machine.id === placement.machineId)
}
