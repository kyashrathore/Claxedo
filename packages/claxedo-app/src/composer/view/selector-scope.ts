import { createEffect, createMemo, untrack, type Accessor } from "solid-js"
import type { HarnessScopeInput, HarnessSelectionController } from "../harness/controller"
import type { HarnessOptionList } from "../harness/harness-option-list"
import { isCatalogHarness } from "../harness/profile"

export function createSelectorScope(input: {
  scope: Accessor<string>
  scopeInput: Accessor<HarnessScopeInput>
  sessionLocked: Accessor<boolean | undefined>
  active: Accessor<boolean | undefined>
  controller: Accessor<HarnessSelectionController>
}) {
  const scopeInput = createMemo(() => input.scopeInput())
  const placementId = createMemo(() => scopeInput().placementId)
  const sessionId = createMemo(() => scopeInput().sessionId)
  const sessionLocked = createMemo(() => !!input.sessionLocked())
  const scope = createMemo(() => input.scope())
  createEffect(() => {
    const nextScope = scope()
    const nextInput = scopeInput()
    if (input.active() === false || !nextInput.placementId) return
    untrack(() => {
      void input.controller().hydrate(nextScope, nextInput)
    })
  })
  return { scope, scopeInput, placementId, sessionId, sessionLocked }
}

export function createScopeSelection(input: {
  controller: Accessor<HarnessSelectionController>
  scope: Accessor<string>
  connectionRows: HarnessOptionList["connectionRows"]
}) {
  const selection = createMemo(() => input.controller().read(input.scope()))
  const connectionDeclaration = createMemo(() => {
    const harness = selection().harness
    return harness?.kind === "connection" ? input.connectionRows().find((row) => row.connectionId === harness.connectionId) : undefined
  })
  createEffect(() => input.controller().setConnectionDeclaration?.(input.scope(), connectionDeclaration()))
  const harness = createMemo(() => selection().harness)
  const catalogSelected = createMemo(() => !!harness() && isCatalogHarness(harness()))
  return { selection, connectionDeclaration, harness, catalogSelected }
}
