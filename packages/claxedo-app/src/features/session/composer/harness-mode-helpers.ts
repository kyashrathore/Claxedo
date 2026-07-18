import type { Accessor } from "solid-js"
import type { HarnessSelectionController, HarnessSubmitController } from "@/features/session/harness/controller"
import { composerHarnessId, isComposerHarnessMode, type ComposerMode } from "./mode"

/**
 * The composer's per-scope harness-mode predicates, factored out of
 * `composer.tsx`. They fold the active {@link ComposerMode} together with the
 * submit and selection controllers into the four questions the toolbar and
 * submit wiring ask ("is this scope in harness mode?", "is it ready?", "what
 * harness type?"). Pure delegation — behaviour is identical to the inline
 * closures it replaces.
 */
export function createComposerHarnessMode(deps: {
  composerMode: Accessor<ComposerMode>
  harnessController: HarnessSubmitController
  harnessSelectionController: HarnessSelectionController | undefined
}) {
  const isHarnessMode = (scope: string) => {
    const mode = deps.composerMode()
    if (mode.kind === "session") return isComposerHarnessMode(mode)
    return deps.harnessController.isHarnessMode(scope) || isComposerHarnessMode(mode)
  }
  const toolbarHarnessMode = (scope: string) => {
    const mode = deps.composerMode()
    return isComposerHarnessMode(mode) ||
      deps.harnessController.isHarnessMode(scope) ||
      !!deps.harnessSelectionController?.read(scope).isHarnessMode
  }
  const harnessReadiness = (scope: string) => deps.harnessController.readiness(scope)
  const harnessReadyForSubmit = (scope: string) => deps.harnessController.readyForSubmit(scope)
  const currentHarnessType = (scope: string) => {
    const mode = deps.composerMode()
    if (mode.kind === "session") return composerHarnessId(mode)
    const harness = deps.harnessController.harness(scope)
    return harness === "opencode" ? composerHarnessId(mode) : harness
  }
  return { isHarnessMode, toolbarHarnessMode, harnessReadiness, harnessReadyForSubmit, currentHarnessType }
}
