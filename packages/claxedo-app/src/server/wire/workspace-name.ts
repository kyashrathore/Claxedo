import { nonEmptyString } from "@claxedo/helpers/guards"
import type { PlacementKind, PlacementName } from "../types"
import { isCheckpointUnusableRow } from "./connection"
import { cloudLifecycleOf } from "./placement-lifecycle"

export function cloudWorkspaceName(row: Record<string, unknown>, id: string): string | undefined {
  return [row.workspace_name, row.workspaceName, row.display_name, row.displayName].map(nonEmptyString).find((name) => name !== undefined && name !== id)
}

export function placementName(row: Record<string, unknown>, id: string, kind: PlacementKind, path: string | undefined): PlacementName {
  const own = cloudWorkspaceName(row, id)
  if (kind === "cloud") {
    const lifecycle = cloudLifecycleOf(row)
    const failure = lifecycle === "failed" ? nonEmptyString(row.error) : undefined
    const unusable = lifecycle === "failed" && isCheckpointUnusableRow(row)
    return { kind, lifecycle, ...(own ? { label: own } : {}), ...(failure ? { failure } : {}), ...(unusable ? { checkpointUnusable: true } : {}) }
  }
  return { kind, label: own ?? path?.split("/").filter(Boolean).pop() ?? path ?? id }
}
