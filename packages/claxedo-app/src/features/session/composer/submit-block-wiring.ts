import { createMemo, type Accessor, type JSX } from "solid-js"
import { loadAIConnectDialog, useProviders } from "@/features/session/app-ports"
import { useLocal } from "@/features/session/providers/session-selection"
import type { HarnessReadiness } from "@/features/session/harness/selection"
import type { HarnessSelectionController, HarnessSubmitController } from "@/features/session/harness/controller"
import { submitBlockedByWorkspaceRole } from "@/features/session/composer/role-gate"
import { createPromptToolbarState } from "./toolbar-state"
import { openComposerAIConnect } from "./ai-connect"
import { submitBlockReason, type SubmitBlock } from "./submit-block-reason"

/**
 * The composer's submit-block wiring (T5): the single priority-ordered
 * "why is Send blocked?" derivation and the two intent actions that resolve an
 * actionable block (connect an AI provider, choose a model). Factored out of
 * `composer.tsx` so the six-boolean-to-one-vocabulary logic is one cohesive
 * unit instead of scattered memos and closures in the component body.
 *
 * Behaviour is identical to the inline version: `submitBlock` is the one source
 * of truth both `submitInertBlocked` and the explain-on-intent copy derive from;
 * `roleSubmitBlocked` hard-blocks the handler unconditionally; `openAIConnect`
 * reuses the first-turn onboarding dialog loader and `openModelPicker` clicks the
 * model picker already rendered in the toolbar.
 */
export function createComposerSubmitBlockWiring(deps: {
  workspaceId?: Accessor<string | undefined>
  scope: () => string
  isHarnessMode: (scope: string) => boolean
  harnessReadiness: (scope: string) => HarnessReadiness
  harnessReadyForSubmit: (scope: string) => boolean
  harnessSelectionController: HarnessSelectionController | undefined
  harnessController: HarnessSubmitController
  toolbarState: ReturnType<typeof createPromptToolbarState>
  providers: ReturnType<typeof useProviders>
  local: ReturnType<typeof useLocal>
  booting: Accessor<boolean>
  stoppable: Accessor<boolean>
  blank: Accessor<boolean>
  showDialog: (content: () => JSX.Element) => unknown
  harnessDirectory: Accessor<string | undefined>
  resolvedSessionId: () => string | undefined
  rootEl: () => HTMLDivElement | undefined
}) {
  const roleSubmitBlocked = createMemo(() => submitBlockedByWorkspaceRole(deps.workspaceId?.()))
  // One priority-ordered source of truth for "why is Send blocked?" (T5). Both
  // `submitDisabled` and the explain-on-intent copy derive from this; they never
  // diverge into the six-boolean drift the old composer had.
  const submitBlock = createMemo<SubmitBlock | null>(() => {
    const nextScope = deps.scope()
    const harnessMode = deps.isHarnessMode(nextScope)
    const harnessState = deps.harnessSelectionController?.read(nextScope)
    const draftDefaultState = harnessState?.draftDefaultState
    const modelReadiness = deps.toolbarState.readiness()
    return submitBlockReason({
      roleBlocked: roleSubmitBlocked(),
      harnessMode,
      harnessReadiness: deps.harnessReadiness(nextScope),
      harnessConfigError: !!harnessState?.configError,
      harnessOptionsLoading: !!harnessState?.optionsLoading,
      harnessReadyForSubmit: deps.harnessReadyForSubmit(nextScope),
      needsModelSelection: draftDefaultState === "choose-model" || draftDefaultState === "saved-model-unavailable",
      modelBlocked: deps.toolbarState.modelSubmitBlocked(),
      modelBlockLabel: modelReadiness.label,
      providerLoading: deps.providers.loading(),
      booting: deps.booting(),
      stoppable: deps.stoppable(),
      blank: deps.blank(),
    })
  })
  // Inert reasons (empty/booting/models-loading/harness-polling) keep the button
  // hard-disabled; actionable reasons stay clickable (dimmed) so they can explain
  // their refusal on intent.
  const submitInertBlocked = createMemo(() => {
    const block = submitBlock()
    return !!block && !block.actionable
  })
  // Same loader the first-turn onboarding uses (loadAIConnectDialog). Reused by
  // the toolbar model-connect button and the no-credential explain-on-intent action.
  const openAIConnect = () => void openComposerAIConnect({
    loadDialog: loadAIConnectDialog, show: deps.showDialog, providers: deps.providers,
    scope: deps.scope(), directory: deps.harnessDirectory(), sessionId: deps.resolvedSessionId(), harnessSelectionController: deps.harnessSelectionController,
    harnessSubmitController: deps.harnessController, setModel: (model) => deps.harnessSelectionController
      ? deps.harnessSelectionController.setModel(deps.scope(), model, { directory: deps.harnessDirectory(), sessionId: deps.resolvedSessionId() })
      : deps.local.model.set(model),
  })
  // Reuse whichever model picker this composer rendered. Harness modes own a
  // separate control from OpenCode's, but both resolve the same no-model action.
  // Two separate lookups, not one multi-selector `querySelector`: that resolves
  // by document order, not selector order, so it cannot express a preference.
  const openModelPicker = () => {
    const root = deps.rootEl()
    if (!root) return
    const picker =
      root.querySelector<HTMLElement>('[data-action="prompt-harness-model"]') ??
      root.querySelector<HTMLElement>('[data-action="prompt-model"]')
    picker?.click()
  }

  return { roleSubmitBlocked, submitBlock, submitInertBlocked, openAIConnect, openModelPicker }
}
