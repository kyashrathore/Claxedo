import type { Loaded } from "@/projects"
import type { AppError, Placement, PlacementId, Project, ProjectId } from "@/server"

export type ProjectUnavailable = { readonly kind: "folderMissing"; readonly directory: string } | { readonly kind: "workspaceUnavailable" }

export type ReadyPlacement = { readonly kind: "ready"; readonly placementId: PlacementId; readonly label: string }

export type SettingsPlacement =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly error: AppError }
  | { readonly kind: "noProject" }
  | { readonly kind: "unavailable"; readonly project: string; readonly why: ProjectUnavailable }
  | ReadyPlacement

function unavailableWhy(project: Project): ProjectUnavailable {
  return project.missingCheckout ? { kind: "folderMissing", directory: project.missingCheckout.directory } : { kind: "workspaceUnavailable" }
}

export function settingsPlacement(inCatalogOrder: Loaded<readonly Project[]>, primaryOf: (project: ProjectId) => Placement | undefined): SettingsPlacement {
  if (inCatalogOrder.kind !== "ready") return inCatalogOrder
  for (const project of inCatalogOrder.data) {
    const placement = project.available ? primaryOf(project.id) : undefined
    if (placement) return { kind: "ready", placementId: placement.id, label: project.name }
  }
  const [first] = inCatalogOrder.data
  return first ? { kind: "unavailable", project: first.name, why: unavailableWhy(first) } : { kind: "noProject" }
}

export function readyPlacement(placement: SettingsPlacement): ReadyPlacement | undefined {
  return placement.kind === "ready" ? placement : undefined
}
