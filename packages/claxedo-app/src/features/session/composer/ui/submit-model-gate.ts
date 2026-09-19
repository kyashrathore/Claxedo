import { isCatalogHarness } from "../../harness/profile"
import { resolveSubmittedConfig } from "../../submit/resolve"
import type { ResolveSubmittedConfigContext } from "../../submit/types"
import type { ExistingSessionConfig } from "./submit-session-config"
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
  hostKind: string
  selection: HarnessSelection | undefined
  modelKey: ModelKey | undefined
}) {
  if (!input.isNewSession || input.hostKind !== "provisioner") return false
  return !input.selection || !input.modelKey
}

/** Resolve effort and model ownership for a draft or an already-bound session. */
export function resolvePromptSubmitConfig(input: {
  existing?: ExistingSessionConfig
  harnessMode: boolean
  selection?: HarnessSelection
  variant: () => string | undefined
  modelKey: () => ModelKey | undefined
  currentAgent: () => ResolveSubmittedConfigContext["currentAgent"]
  defaultAgent: () => ResolveSubmittedConfigContext["defaultAgent"]
  agent: () => string | undefined
}) {
  const providerOwnsEffort = !input.harnessMode || (input.selection !== undefined && isCatalogHarness(input.selection))
  const selectedVariant = providerOwnsEffort ? input.variant() : undefined
  const existing = input.existing
  if (existing?.model) {
    const variant = selectedVariant ?? existing.variant
    return {
      model: existing.model,
      agent: input.agent() || existing.agent || input.currentAgent()?.id || input.currentAgent()?.name || "build",
      ...(variant ? { variant } : {}),
    }
  }
  return resolveSubmittedConfig({
    harnessModelKey: input.modelKey(),
    ...(selectedVariant ? { variant: selectedVariant } : {}),
    currentAgent: input.currentAgent(),
    defaultAgent: input.defaultAgent(),
    agentOverride: input.agent(),
  })
}
