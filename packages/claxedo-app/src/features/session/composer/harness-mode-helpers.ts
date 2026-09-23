import type { Accessor } from "solid-js"
import type { HarnessSelectionController, HarnessSubmitController } from "@/features/session/harness/controller"
import { composerHarnessId, isComposerHarnessMode, type ComposerMode } from "./mode"

/**
 * The composer's per-scope harness-mode predicates. They fold the active
 * {@link ComposerMode} together with the submit and selection controllers into
 * the questions the toolbar and submit wiring ask ("is this scope in harness
 * mode?", "is it ready?", "what harness type?"). A session's harness type is a
 * held pick while there is one, because that is what its next send runs on.
 */
export function createComposerHarnessMode(deps: {
  composerMode: Accessor<ComposerMode>
  harnessController: HarnessSubmitController
  harnessSelectionController: HarnessSelectionController | undefined
}) {
  const isHarnessMode = (scope: string) => {
    const mode = deps.composerMode()
    if (mode.kind === "session") {
      return isComposerHarnessMode(mode) || deps.harnessController.isHarnessMode(scope)
    }
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
    if (mode.kind === "session") {
      return deps.harnessController.heldHarness(scope) ?? composerHarnessId(mode) ?? deps.harnessController.harness(scope)
    }
    const harness = deps.harnessController.harness(scope)
    return harness ?? composerHarnessId(mode)
  }
  return { isHarnessMode, toolbarHarnessMode, harnessReadiness, harnessReadyForSubmit, currentHarnessType }
}
