import { nonEmptyString } from "@claxedo/helpers/guards"
import type { PlacementKind, PlacementName } from "../types"

export function cloudWorkspaceName(row: Record<string, unknown>, id: string): string | undefined {
  return [row.workspace_name, row.workspaceName, row.display_name, row.displayName].map(nonEmptyString).find((name) => name !== undefined && name !== id)
}

export function placementName(row: Record<string, unknown>, id: string, kind: PlacementKind, path: string | undefined): PlacementName {
  const own = cloudWorkspaceName(row, id)
  if (kind === "cloud") return own ? { kind, label: own } : { kind }
  return { kind, label: own ?? path?.split("/").filter(Boolean).pop() ?? path ?? id }
}
