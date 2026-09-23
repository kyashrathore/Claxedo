import { resolveSubmittedConfig } from "../../submit/resolve"
import type { ResolveSubmittedConfigContext } from "../../submit/types"
import type { ExistingSessionConfig } from "./submit-session-config"
import type { HarnessSelection } from "@/platform/identity/harness-selection"
import type { ModelKey } from "../model-strategy"

/**
 * The directory-independent half of the explicit-model gate, evaluated BEFORE
 * directory resolution for a new submit onto the provisioner. Resolving the
 * directory provisions a real machine, so a submit that would fail the model
 * gate afterwards must be rejected first — otherwise the provisioned workspace
 * is orphaned (nothing ever adopts or deletes it). The full gate in submit.ts
 * still rejects a selected model the provisioned runtime cannot resolve.
 */
export function cloudSubmitMissingModel(input: {
  isNewSession: boolean
  hostKind: string
  selection: HarnessSelection | undefined
  modelOptional?: boolean
  modelKey: ModelKey | undefined
}) {
  if (!input.isNewSession || input.hostKind !== "provisioner") return false
  return !input.selection || (!(input.modelOptional && input.selection.kind === "connection") && !input.modelKey)
}

/** Resolve effort and model ownership for a draft or an already-bound session. */
export function resolvePromptSubmitConfig(input: {
  modelOptional?: boolean
  existing?: ExistingSessionConfig
  harnessMode: boolean
  selection?: HarnessSelection
  variant: () => string | undefined
  modelKey: () => ModelKey | undefined
  currentAgent: () => ResolveSubmittedConfigContext["currentAgent"]
  defaultAgent: () => ResolveSubmittedConfigContext["defaultAgent"]
  agent: () => string | undefined
}) {
  // Outside harness mode the provider picker owns effort; every harness —
  // native or catalog — keeps its level in the harness picker's store.
  const providerOwnsEffort = !input.harnessMode
  // A bound session's model is its saved config (a picked model is saved before
  // a submit reads it), but a changed effort lives only in the picker until a
  // turn carries it. The picker speaks for the session once it holds the
  // session's own model — hydration sets exactly that — and then its level, or
  // explicitly none, is what the turn runs at. Before that its key is another
  // scope's, and the saved level stands.
  const picked = providerOwnsEffort ? undefined : input.modelKey()
  const selectedVariant = providerOwnsEffort ? input.variant() : picked?.variant
  const existing = input.existing
  if (existing) {
    const describesSession = !!picked && picked.providerID === existing.model?.providerID && picked.modelID === existing.model.modelID
    const variant: string | null | undefined = providerOwnsEffort
      ? selectedVariant ?? existing.variant
      : describesSession ? picked.variant ?? null : existing.variant
    const agent = input.agent() || existing.agent
    const config = resolveSubmittedConfig({
      harnessModelKey: existing.model,
      modelOptional: existing.harnessType.kind === "connection",
      currentAgent: agent ? undefined : input.currentAgent(),
      agentOverride: agent,
      ...(variant ? { variant } : {}),
    })
    return config && { ...config, ...(variant !== undefined ? { variant } : {}) }
  }
  return resolveSubmittedConfig({
    modelOptional: input.modelOptional && input.selection?.kind === "connection",
    harnessModelKey: input.modelKey(),
    ...(selectedVariant ? { variant: selectedVariant } : {}),
    currentAgent: input.currentAgent(),
    defaultAgent: input.defaultAgent(),
    agentOverride: input.agent(),
  })
}
