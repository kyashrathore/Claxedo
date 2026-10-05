import type { WorkspaceName } from "@/cloud"
import type { DomainTranslate } from "@/i18n"
import { machineOfPlacement, type Machine, type Placement } from "@/server"
import type { RailKey } from "./i18n"

export type SessionMarkerKind = "cloud" | "machine" | "worktree"

export type SessionMarker =
  | { readonly kind: "cloud"; readonly name?: string; readonly branch?: string }
  | { readonly kind: "machine"; readonly name: string; readonly folder: string }
  | { readonly kind: "worktree"; readonly name: string; readonly path: string | undefined }

export function sessionMarker(placement: Placement | undefined, machines: readonly Machine[]): SessionMarker | undefined {
  if (!placement) return undefined
  if (placement.kind === "cloud") return { kind: "cloud", ...(placement.label ? { name: placement.label } : {}), ...(placement.branch ? { branch: placement.branch } : {}) }
  const machine = placement.onThisMachine ? undefined : machineOfPlacement(machines, placement)
  if (machine) return { kind: "machine", name: machine.name, folder: placement.label }
  return placement.kind === "worktree" ? { kind: "worktree", name: placement.label, path: placement.path } : undefined
}

export function markerName(named: WorkspaceName, marker: SessionMarker): string {
  return marker.kind === "cloud" ? named(marker.name, marker.branch) : marker.name
}

export function markerLabel(t: DomainTranslate<RailKey>, marker: SessionMarker, projectLabel: string): string {
  if (marker.kind === "cloud") return [t("rail.marker.cloud"), marker.name ?? marker.branch].filter(Boolean).join(" · ")
  if (marker.kind === "machine") return t("rail.marker.machine", { folder: marker.folder, machine: marker.name })
  const base = t("rail.marker.worktree", { project: projectLabel, name: marker.name })
  return marker.path && marker.path !== marker.name ? `${base} · ${marker.path}` : base
}
