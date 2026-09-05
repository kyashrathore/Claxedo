import type { HarnessSelection } from "@/platform/identity/harness-selection"
import type { ModelKey } from "../model-strategy"

/**
 * The directory-independent half of the explicit-model gate, evaluated BEFORE
 * directory resolution for a new cloud submit. Resolving the directory
 * provisions a real cloud workspace, so a submit that would fail the model
 * gate afterwards must be rejected first — otherwise the created workspace is
 * orphaned (nothing ever adopts or deletes it). The full gate in submit.ts
 * still rejects a selected model the provisioned runtime cannot resolve.
 */
export function cloudSubmitMissingModel(input: {
  isNewSession: boolean
  workspaceKind: string
  selection: HarnessSelection | undefined
  modelKey: ModelKey | undefined
}) {
  if (!input.isNewSession || input.workspaceKind !== "cloud") return false
  return !input.selection || !input.modelKey
}
