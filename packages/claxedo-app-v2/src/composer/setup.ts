import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { isStoppedCloud, useServer, type PlacementId, type PromptInput } from "@/server"
import type { SessionView } from "@/session"
import { showToast, useDialog } from "@/ui"
import type { ImagePart, Submission } from "./model"
import { promptImages } from "./model"
import { useComposerStore, type ComposerKey, type ComposerStore } from "./store"
import { useCommands, useShellRegistries, type Commands } from "@/shell"
import { useComposerText } from "./text"
import { createAttachmentReader, type DraggingType } from "./attachments/reader"
import { registerComposerCommands } from "./composer-commands"
import { createComposerHarness, type ComposerHarness } from "./composer-harness"
import { createComposerController, type ComposerController } from "./controller"
import { createComposerRefs, type ComposerRefs } from "./refs"
import { createComposerSend } from "./send"
import { createSuggestions, type SlashItem, type SuggestionQuery } from "./suggestions"
import { harnessProfile } from "./harness/profile"
import { submitBlockReason } from "./submit-block-reason"
import { createRecovery, type ComposerRecovery } from "./recovery"

export type ComposerProps = {
  readonly composerKey: ComposerKey
  readonly placementId?: PlacementId
  readonly view?: SessionView
  readonly sessionHarness?: string
  readonly attachmentWorkspace: boolean
  readonly readOnly?: boolean
  readonly hidden?: boolean
  readonly createSession?: (submission: Submission) => Promise<SessionView>
  readonly afterAccepted?: (view: SessionView) => void
  readonly queuedEdit?: { readonly active: () => boolean; readonly cancel: () => void; readonly replace: (input: PromptInput) => Promise<boolean> }
  readonly dropZone?: () => HTMLElement | undefined
  readonly collapsible?: boolean
  readonly registerRecovery?: (recovery: ComposerRecovery) => void
  readonly openImageMarks?: (image: ImagePart, focusIndex?: number) => void
}

type Late = { controller?: ComposerController }

type HarnessSelection = ComposerHarness

function goalCapable(props: ComposerProps, selection: HarnessSelection): boolean {
  if (props.view) return props.view.goalAvailable() !== false
  return (selection.harness()?.goalMode ?? "none") !== "none"
}

function sessionWorking(view: SessionView | undefined): boolean {
  const kind = view?.status().kind
  return kind === "working" || kind === "retrying" || kind === "recovering"
}


function createSendFor(props: ComposerProps, store: ComposerStore, key: Accessor<ComposerKey>, selection: HarnessSelection, late: Late, t: ReturnType<typeof useComposerText>) {
  return createComposerSend({
    key,
    store,
    working: () => sessionWorking(props.view),
    mode: () => late.controller?.state.mode ?? "normal",
    normalMode: () => late.controller?.setMode("normal"),
    submission: selection.submission,
    goalCapable: () => goalCapable(props, selection),
    view: () => props.view,
    createSession: props.createSession,
    queuedReplace: () => (props.queuedEdit?.active() ? props.queuedEdit.replace : undefined),
    afterAccepted: (view) => {
      late.controller?.resetHistory()
      props.afterAccepted?.(view)
    },
    focusEditor: () => late.controller?.focusEditor(),
    goalStopFailed: (error) =>
      showToast({ title: t("prompt.toast.goalStopFailed.title"), description: error instanceof Error ? error.message : String(error) }),
  })
}

function createReaderFor(input: {
  props: ComposerProps
  store: ComposerStore
  key: Accessor<ComposerKey>
  refs: ComposerRefs
  selection: HarnessSelection
  setDragging: (type: DraggingType) => void
  late: Late
}) {
  const dialog = useDialog()
  return createAttachmentReader({
    key: input.key,
    store: input.store,
    editor: input.refs.editor,
    zone: () => (input.props.hidden ? undefined : (input.props.dropZone?.() ?? input.refs.root())),
    isDialogActive: () => !!dialog.active,
    target: () => {
      const current = input.selection.harness()
      return { harness: current ? { id: current.id, name: current.name } : undefined, workspace: input.props.attachmentWorkspace }
    },
    setDraggingType: input.setDragging,
    focusEditor: () => input.late.controller?.focusEditor(),
  })
}

function createControllerFor(input: {
  key: Accessor<ComposerKey>
  store: ComposerStore
  refs: ComposerRefs
  working: Accessor<boolean>
  suggestions: ReturnType<typeof createSuggestions>
  send: ReturnType<typeof createComposerSend>
  commands: Commands
}) {
  return createComposerController({
    key: input.key,
    store: input.store,
    refs: input.refs,
    working: input.working,
    atItems: input.suggestions.atItems,
    slashItems: input.suggestions.slashItems,
    submit: () => void input.send.send(),
    stop: () => void input.send.stop(),
    edited: input.send.edited,
    runCommand: (item: SlashItem) => input.commands.trigger(item.id, "slash"),
  })
}

export function createComposer(props: ComposerProps) {
  const server = useServer()
  const store = useComposerStore()
  const t = useComposerText()
  const key: Accessor<ComposerKey> = () => props.composerKey
  createEffect(on(key, (current) => onCleanup(store.retain(current))))
  const late: Late = {}
  const refs = createComposerRefs()
  const selection = createComposerHarness(props, key, t)
  const working = createMemo(() => sessionWorking(props.view))
  const goalAvailable = createMemo(() => goalCapable(props, selection))
  const [query, setQuery] = createSignal<SuggestionQuery>({ kind: "closed" })
  const [dragging, setDragging] = createSignal<DraggingType>(null)
  const registries = useShellRegistries()
  const commands = useCommands()
  const suggestions = createSuggestions({ registries, commandOptions: commands.slashOptions, placementId: () => props.placementId, query })
  const send = createSendFor(props, store, key, selection, late, t)
  const reader = createReaderFor({ props, store, key, refs, selection, setDragging, late })
  const controller = createControllerFor({ key, store, refs, working, suggestions, send, commands })
  late.controller = controller
  props.registerRecovery?.(
    createRecovery({ store, key, controller: selection.controller, scopeInput: selection.scopeInput, send: () => send.send(), dialog: useDialog(), t }),
  )
  registerComposerCommands({ key, harness: selection, controller, refs, send, goalAvailable, hidden: () => props.hidden === true, t })
  createEffect(() => setQuery(controller.suggestionQuery()))
  const draft = () => store.draft(key())
  const shared = { t, key, store, refs, send, reader, suggestions, controller, dragging, draft, working, goalAvailable }
  return {
    ...shared,
    ...submitState({ key, selection, send, controller, working, asleep: () => isStoppedCloud(props.placementId ? server.placements.byId(props.placementId) : undefined) }),
    harness: selection.harness,
    harnessController: selection.controller,
    harnessScopeInput: selection.scopeInput,
    permissionMode: selection.permissionMode,
    images: createMemo(() => promptImages(draft().prompt)),
    attachments: () => store.attachments(key()),
    disabled: () => props.readOnly === true,
  }
}

function submitState(input: {
  key: Accessor<ComposerKey>
  selection: HarnessSelection
  send: ReturnType<typeof createComposerSend>
  controller: ComposerController
  working: Accessor<boolean>
  asleep: Accessor<boolean>
}) {
  const { selection, send } = input
  const booting = createMemo(() => send.boot() !== undefined)
  const submitBlock = createMemo(() => {
    const state = selection.selection()
    const harnessMode = !!state.harness
    return submitBlockReason({
      authorityBlock: undefined,
      harnessMode,
      draftConnectionAllowsNoModel: state.canCreateWithoutModel,
      harnessReadiness: state.readiness,
      harnessConfigError: !!state.configError,
      harnessOptionsLoading: state.optionsLoading,
      harnessReadyForSubmit: selection.submit.readyForSubmit(input.key()),
      needsModelSelection: state.draftDefaultState === "choose-model" || state.draftDefaultState === "saved-model-unavailable",
      modelBlocked: !harnessMode,
      modelBlockLabel: undefined,
      providerLoading: false,
      booting: booting(),
      stoppable: input.working(),
      blank: input.controller.blank(),
      workspaceAsleep: input.asleep(),
    })
  })
  const bootText = () => {
    const type = selection.selection().harness
    return send.boot() === "sending" ? "Sending first message..." : `Booting ${type ? harnessProfile(type).displayName : "Select harness"}...`
  }
  return { harnessPending: createMemo(() => selection.selection().readiness === "polling"), booting, bootText, submitBlock }
}

export type ComposerSetup = ReturnType<typeof createComposer>
