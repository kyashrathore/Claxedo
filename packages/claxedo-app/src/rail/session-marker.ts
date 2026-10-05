import { machineOfPlacement, type Machine, type Placement } from "@/server"

export type SessionMarkerKind = "cloud" | "machine" | "worktree"

export type SessionMarker =
  | { readonly kind: "cloud"; readonly name: string }
  | { readonly kind: "machine"; readonly name: string; readonly folder: string }
  | { readonly kind: "worktree"; readonly name: string; readonly path: string | undefined }

export function sessionMarker(placement: Placement | undefined, machines: readonly Machine[]): SessionMarker | undefined {
  if (!placement) return undefined
  if (placement.kind === "cloud") return { kind: "cloud", name: placement.label }
  const machine = placement.onThisMachine ? undefined : machineOfPlacement(machines, placement)
  if (machine) return { kind: "machine", name: machine.name, folder: placement.label }
  return placement.kind === "worktree" ? { kind: "worktree", name: placement.label, path: placement.path } : undefined
}
