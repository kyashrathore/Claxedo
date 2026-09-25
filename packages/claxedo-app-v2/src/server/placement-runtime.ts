import type { Placement } from "./types"

export function isStoppedCloud(placement: Placement | undefined): boolean {
  return placement?.kind === "cloud" && !placement.reachable
}

export function listsSessions(placement: Placement): boolean {
  return placement.reachable || placement.kind === "cloud"
}
