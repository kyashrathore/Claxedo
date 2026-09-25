import type { HarnessWiring } from "./harness-wiring"
import { harnessSelectionId } from "./profile"
import type { HarnessScopeInput } from "./store-policy"
import { harnessHealthReadiness } from "./store-state"

// Probe the bound runtime without changing persisted harness/model identity.
// Hydration alone cannot detect a runtime that exits after the session loads.
export async function probeHarnessHealth({ api, store }: HarnessWiring, scope: string, input?: HarnessScopeInput) {
  if (!input?.placementId || store.heldHarness(scope)) return
  const current = store.read(scope)
  if (!current.harness) return
  const data = await api.folderHarness(input.placementId, input.sessionId).catch((error: unknown) => {
    console.warn(`The harness health probe for placement ${input.placementId} failed`, error)
    return undefined
  })
  if (!data) return
  const held = store.read(scope)
  if (held.harness?.kind !== current.harness.kind || (held.harness.kind === "connection" && (current.harness.kind !== "connection" || held.harness.connectionId !== current.harness.connectionId))) return
  if (held.harness.kind === "connection" && data.connectionState?.connectionId === held.harness.connectionId) {
    store.applyPatch(scope, { connectionState: data.connectionState })
  }
  const next = harnessHealthReadiness({ harness: current.harness, current: store.read(scope).readiness, health: data.harnessHealth?.status })
  if (next) store.setReadiness(scope, next)
}

/** A harness held in the picker becomes the session's own before the prompt is sent; a failed switch leaves the draft unsent. */
export async function commitHeldHarness({ api, store }: HarnessWiring, scope: string, input: HarnessScopeInput) {
  const held = store.heldHarness(scope)
  const ref = input.sessionRef
  if (!held || !ref) return
  const model = store.harnessModelKeyForSubmit(scope)
  await api.updateSessionConfig(ref, {
    harness: harnessSelectionId(held),
    ...(model ? { model: { providerId: model.providerId, modelId: model.modelId } } : {}),
    ...(model?.variant ? { variant: model.variant } : {}),
  })
  store.releaseHeldHarness(scope)
}
