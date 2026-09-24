import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import { useServer } from "@/server"
import type { SessionView } from "@/session"
import { connectionHarness, harnessSelectionValue, nativeHarness, NATIVE_HARNESS_IDS, type NativeHarnessId } from "@/lib/harness-selection"
import { showToast, useDialog } from "@/ui"
import type { ImagePart, Submission } from "./model"
import { promptImages } from "./model"
import { useComposerStore, type ComposerKey, type ComposerStore } from "./store"
import { useCommands, useShellRegistries, type Commands } from "@/shell"
import { useComposerText } from "./text"
import { createAttachmentReader, type DraggingType } from "./attachments/reader"
import { createComposerController, type ComposerController } from "./controller"
import { createComposerRefs, type ComposerRefs } from "./refs"
import { createComposerSend } from "./send"
import { createSuggestions, type SlashItem, type SuggestionQuery } from "./suggestions"
import { useHarnessConfig } from "./harness/context"
import { createHarnessSelectionController, createHarnessSubmitController, type HarnessScopeInput } from "./harness/controller"
import { harnessProfile, harnessSelectionId, type HarnessType } from "./harness/profile"
import { submitBlockReason } from "./submit-block-reason"
import { registerPromptModeCommands } from "./view/mode-commands"
import { createComposerPermissionSurface } from "./permission/permission-mode-wiring"
import { harnessModesUnavailable } from "./role-gate"
import { createRecovery, type ComposerRecovery } from "./recovery"

export type ComposerProps = {
  readonly composerKey: ComposerKey
  readonly placementId?: PlacementId
  readonly view?: SessionView
  readonly sessionHarness?: string
  readonly attachmentWorkspace: boolean
  readonly readOnly?: boolean
  readonly createSession?: (submission: Submission) => Promise<SessionView>
  readonly afterAccepted?: (view: SessionView) => void
  readonly queuedEdit?: { readonly active: () => boolean; readonly cancel: () => void }
  readonly dropZone?: () => HTMLElement | undefined
  readonly collapsible?: boolean
  readonly registerRecovery?: (recovery: ComposerRecovery) => void
  readonly openImageMarks?: (image: ImagePart, focusIndex?: number) => void
}

type Late = { controller?: ComposerController }

function harnessOfId(id: string): HarnessType {
  const native = NATIVE_HARNESS_IDS.find((candidate): candidate is NativeHarnessId => candidate === id)
  return native ? nativeHarness(native) : connectionHarness(id)
}

function createHarnessSelection(props: ComposerProps, key: Accessor<ComposerKey>, t: ReturnType<typeof useComposerText>) {
  const server = useServer()
  const store = useHarnessConfig()
  const controller = createHarnessSelectionController(store)
  const submit = createHarnessSubmitController(store)
  const scopeInput = createMemo<HarnessScopeInput>(() => {
    const view = props.view
    if (!view) return { placementId: props.placementId }
    return {
      placementId: view.ref.placementId,
      sessionId: view.ref.sessionId,
      sessionRef: view.ref,
      ...(props.sessionHarness ? { sessionHarness: harnessOfId(props.sessionHarness) } : {}),
    }
  })
  const selection = createMemo(() => controller.read(key()))
  const permissionHarness = () => {
    const type = selection().harness
    return type ? harnessSelectionValue(type) : undefined
  }
  const { permissionMode } = createComposerPermissionSurface({
    api: server.harnessConfig,
    placementId: () => scopeInput().placementId,
    sessionRef: () => (submit.heldHarness(key()) ? undefined : scopeInput().sessionRef),
    harness: permissionHarness,
    harnessSelection: () => selection().harness,
    harnessUnavailable: () =>
      harnessModesUnavailable({
        isHarness: !!selection().harness,
        readiness: selection().readiness,
        configError: !!selection().configError,
        harness: permissionHarness(),
      }),
    requestFailedTitle: () => t("common.requestFailed"),
  })
  const harness = createMemo(() => {
    const type = submit.heldHarness(key()) ?? selection().harness
    return type ? server.capabilities()?.harnesses.find((info) => info.id === harnessSelectionId(type)) : undefined
  })
  const submission = async (): Promise<Submission> => {
    const scope = key()
    await submit.settledModel(scope)
    const held = submit.heldHarness(scope)
    const model = submit.modelKeyForSubmit(scope)
    const tier = submit.serviceTierForSubmit(scope)
    await store.commitHeldHarness(scope, scopeInput())
    const type = held ?? submit.harness(scope)
    const mode = permissionMode.promptModeId()
    return {
      ...(type ? { harness: harnessSelectionId(type) } : {}),
      ...(model ? { model: { providerId: model.providerID, modelId: model.modelID } } : {}),
      ...(model?.variant ? { effort: model.variant } : {}),
      ...(tier ? { serviceTier: tier } : {}),
      ...(mode ? { permissionMode: mode } : {}),
    }
  }
  return { controller, submit, scopeInput, selection, harness, submission, permissionMode }
}

type HarnessSelection = ReturnType<typeof createHarnessSelection>

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
    goalMode: () => selection.harness()?.goalMode,
    view: () => props.view,
    createSession: props.createSession,
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
    zone: () => input.props.dropZone?.() ?? input.refs.root(),
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
  const store = useComposerStore()
  const t = useComposerText()
  const key: Accessor<ComposerKey> = () => props.composerKey
  createEffect(on(key, (current) => onCleanup(store.retain(current))))
  const late: Late = {}
  const refs = createComposerRefs()
  const selection = createHarnessSelection(props, key, t)
  const working = createMemo(() => sessionWorking(props.view))
  const goalAvailable = createMemo(() => (selection.harness()?.goalMode ?? "none") !== "none")
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
  registerPromptModeCommands({
    register: (scope, options) => commands.register(scope, options),
    mode: () => controller.state.mode,
    pick: () => refs.fileInput()?.click(),
    setMode: controller.setMode,
    goalSelectable: goalAvailable,
    armGoal: send.armGoal,
    labels: {
      attachFile: t("prompt.action.attachFile"),
      fileCategory: t("command.category.file"),
      shellMode: t("command.prompt.mode.shell"),
      normalMode: t("command.prompt.mode.normal"),
      sessionCategory: t("command.category.session"),
      goal: t("prompt.action.goal"),
    },
  })
  createEffect(() => setQuery(controller.suggestionQuery()))
  const draft = () => store.draft(key())
  const harnessPending = createMemo(() => selection.selection().readiness === "polling")
  const booting = createMemo(() => send.boot() !== undefined)
  const bootText = () => {
    const type = selection.selection().harness
    return send.boot() === "sending" ? "Sending first message..." : `Booting ${type ? harnessProfile(type).displayName : "Select harness"}...`
  }
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
      harnessReadyForSubmit: selection.submit.readyForSubmit(key()),
      needsModelSelection: state.draftDefaultState === "choose-model" || state.draftDefaultState === "saved-model-unavailable",
      modelBlocked: !harnessMode,
      modelBlockLabel: undefined,
      providerLoading: false,
      booting: booting(),
      stoppable: working(),
      blank: controller.blank(),
    })
  })
  const shared = { t, key, store, refs, send, reader, suggestions, controller, dragging, draft, working, goalAvailable }
  return {
    ...shared,
    harness: selection.harness,
    harnessController: selection.controller,
    harnessScopeInput: selection.scopeInput,
    permissionMode: selection.permissionMode,
    harnessPending,
    booting,
    bootText,
    submitBlock,
    images: createMemo(() => promptImages(draft().prompt)),
    attachments: () => store.attachments(key()),
    disabled: () => props.readOnly === true,
  }
}

export type ComposerSetup = ReturnType<typeof createComposer>
