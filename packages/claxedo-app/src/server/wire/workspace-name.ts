import { nonEmptyString } from "@claxedo/helpers/guards"
import type { PlacementKind, PlacementName } from "../types"
import { cloudLifecycleOf } from "./placement-lifecycle"

export function cloudWorkspaceName(row: Record<string, unknown>, id: string): string | undefined {
  return [row.workspace_name, row.workspaceName, row.display_name, row.displayName].map(nonEmptyString).find((name) => name !== undefined && name !== id)
}

export function placementName(row: Record<string, unknown>, id: string, kind: PlacementKind, path: string | undefined): PlacementName {
  const own = cloudWorkspaceName(row, id)
  if (kind === "cloud") return { kind, lifecycle: cloudLifecycleOf(row), ...(own ? { label: own } : {}) }
  return { kind, label: own ?? path?.split("/").filter(Boolean).pop() ?? path ?? id }
}
