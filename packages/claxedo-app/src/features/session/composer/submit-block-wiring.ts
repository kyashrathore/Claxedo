import { createMemo, type Accessor } from "solid-js"
import { useProviders, workspacePlacement } from "@/features/session/app-ports"
import type { HarnessReadiness } from "@/features/session/harness/selection"
import type { HarnessSelectionController } from "@/features/session/harness/controller"
import { submitAuthorityBlock } from "@/features/session/composer/role-gate"
import { createPromptToolbarState } from "./toolbar-state"
import { submitBlockReason, type SubmitBlock } from "./submit-block-reason"

/**
 * The composer's "why is Send blocked?" derivation and the intent action that
 * resolves an actionable missing-model block. `submitBlock` is the one source
 * both `submitInertBlocked` and the explain-on-intent copy derive from;
 * `authorityBlock` hard-blocks the handler unconditionally; `openModelPicker`
 * clicks the model picker already rendered in the toolbar.
 */
export function createComposerSubmitBlockWiring(deps: {
  workspaceId?: Accessor<string | undefined>
  /** The session authority's own answer for this session, absent while a draft names none. */
  sessionPromptAdmitted?: Accessor<boolean | undefined>
  statusReady?: Accessor<boolean>
  scope: () => string
  isHarnessMode: (scope: string) => boolean
  harnessReadiness: (scope: string) => HarnessReadiness
  harnessReadyForSubmit: (scope: string) => boolean
  harnessSelectionController: HarnessSelectionController | undefined
  toolbarState: ReturnType<typeof createPromptToolbarState>
  providers: ReturnType<typeof useProviders>
  booting: Accessor<boolean>
  stoppable: Accessor<boolean>
  blank: Accessor<boolean>
  rootEl: () => HTMLDivElement | undefined
}) {
  const authorityBlock = createMemo(() => submitAuthorityBlock({
    sessionPromptAdmitted: deps.sessionPromptAdmitted?.(),
    workspacePlacement: workspacePlacement(deps.workspaceId?.()),
  }))
  const submitBlock = createMemo<SubmitBlock | null>(() => {
    const nextScope = deps.scope()
    const harnessMode = deps.isHarnessMode(nextScope)
    const harnessState = deps.harnessSelectionController?.read(nextScope)
    const draftDefaultState = harnessState?.draftDefaultState
    const modelReadiness = deps.toolbarState.readiness()
    return submitBlockReason({
      sessionStatusReady: deps.statusReady?.(),
      authorityBlock: authorityBlock(),
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

  return { authorityBlock, submitBlock, submitInertBlocked, openModelPicker }
}
