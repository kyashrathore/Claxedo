import { sameHarnessSelection } from "@/lib/harness-selection"
import type { HarnessConnectionState, HarnessHealth } from "@/server"
import type { HarnessWiring } from "./harness-wiring"
import { harnessSelectionId, type HarnessType } from "./profile"
import type { HarnessScopeInput } from "./store-policy"
import { harnessHealthReadiness } from "./store-state"

type ObservedHealth = { readonly harnessHealth?: HarnessHealth; readonly connectionState?: HarnessConnectionState }

function applyHarnessHealth({ store }: HarnessWiring, scope: string, harness: HarnessType, observed: ObservedHealth) {
  const held = store.read(scope)
  if (!sameHarnessSelection(harness, held.harness)) return
  if (held.harness?.kind === "connection" && observed.connectionState?.connectionId === held.harness.connectionId) {
    store.applyPatch(scope, { connectionState: observed.connectionState })
  }
  const next = harnessHealthReadiness({ harness, current: store.read(scope).readiness, health: observed.harnessHealth?.status })
  if (next) store.setReadiness(scope, next)
}

export async function probeHarnessHealth(wiring: HarnessWiring, scope: string, input?: HarnessScopeInput) {
  const { api, store } = wiring
  if (!input?.placementId || store.heldHarness(scope)) return
  const harness = store.read(scope).harness
  if (!harness) return
  const data = await api.folderHarness(input.placementId, input.sessionId).catch((error: unknown) => {
    console.warn(`The harness health probe for placement ${input.placementId} failed`, error)
    return undefined
  })
  if (data) applyHarnessHealth(wiring, scope, harness, data)
}

export function applyPushedHarnessHealth(wiring: HarnessWiring, scope: string, observed: ObservedHealth) {
  const { store } = wiring
  if (!store.state(scope) || store.heldHarness(scope)) return
  const harness = store.read(scope).harness
  if (harness) applyHarnessHealth(wiring, scope, harness, observed)
}

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
