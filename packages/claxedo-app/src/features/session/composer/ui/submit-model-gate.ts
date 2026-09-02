import { isSignedWorkspaceDefaultModel } from "@/features/session/composer/signed-workspace-model"

/**
 * The explicit model selection a submit may carry: the signed-workspace
 * default sentinel is not an explicit choice and never rides a submit.
 */
export function explicitSelectedModel<T extends { id: string; provider: { id: string } }>(
  model: T | undefined,
): T | undefined {
  return model && !isSignedWorkspaceDefaultModel(model) ? model : undefined
}

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
  harnessMode: boolean
  hasHarnessModelKey: boolean
  hasSelectedModel: boolean
}) {
  if (!input.isNewSession || input.workspaceKind !== "cloud") return false
  return input.harnessMode ? !input.hasHarnessModelKey : !input.hasSelectedModel
}
