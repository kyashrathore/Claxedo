import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import { useServer } from "@/server"
import type { SessionView } from "@/session"
import { useDialog } from "@/ui"
import type { ImagePart } from "./model"
import { promptImages } from "./model"
import { useComposerStore, type ComposerKey, type ComposerStore } from "./store"
import { useShellRegistries } from "@/shell"
import { useComposerText } from "./text"
import { createAttachmentReader, type DraggingType } from "./attachments/reader"
import { createComposerController, type ComposerController } from "./controller"
import { createComposerRefs, type ComposerRefs } from "./refs"
import { createComposerSend } from "./send"
import { createSuggestions, type SlashItem, type SuggestionQuery } from "./suggestions"
import { pickHarness, selectionChanged, selectionFor, sessionHarness } from "./selection"

export type ComposerProps = {
  readonly composerKey: ComposerKey
  readonly placementId?: PlacementId
  readonly view?: SessionView
  readonly sessionHarness?: string
  readonly attachmentWorkspace: boolean
  readonly readOnly?: boolean
  readonly createSession?: () => Promise<SessionView>
  readonly afterAccepted?: (view: SessionView) => void
  readonly openImageMarks?: (image: ImagePart, focusIndex?: number) => void
}

type Late = { controller?: ComposerController }

function createHarnessSelection(props: ComposerProps, store: ComposerStore, key: Accessor<ComposerKey>) {
  const server = useServer()
  const harnesses = createMemo(() => server.capabilities()?.harnesses ?? [])
  const selection = () => store.selection(key())
  const harness = createMemo(() =>
    props.view ? sessionHarness(harnesses(), props.sessionHarness) : pickHarness(harnesses(), selection().harness),
  )
  createEffect(() => {
    const next = selectionFor(harness(), selection())
    if (selectionChanged(next, selection())) store.setSelection(key(), next)
  })
  return { harnesses, selection, harness, sendSelection: () => (harness() ? selection() : {}) }
}

type HarnessSelection = ReturnType<typeof createHarnessSelection>

function sessionWorking(view: SessionView | undefined): boolean {
  const kind = view?.status().kind
  return kind === "working" || kind === "retrying" || kind === "recovering"
}

function runCommand(item: SlashItem): void {
  if (item.kind !== "command") return
  Promise.resolve(item.entry.run()).catch((error: unknown) => console.error(`Command ${item.entry.id} failed`, error))
}

function createSendFor(props: ComposerProps, store: ComposerStore, key: Accessor<ComposerKey>, selection: HarnessSelection, late: Late) {
  return createComposerSend({
    key,
    store,
    mode: () => late.controller?.state.mode ?? "normal",
    selection: selection.sendSelection,
    goalMode: () => selection.harness()?.goalMode,
    view: () => props.view,
    createSession: props.createSession,
    afterAccepted: (view) => {
      late.controller?.resetHistory()
      props.afterAccepted?.(view)
    },
    focusEditor: () => late.controller?.focusEditor(),
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
    zone: input.refs.root,
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
    armGoal: input.send.armGoal,
    runCommand,
  })
}

export function createComposer(props: ComposerProps) {
  const store = useComposerStore()
  const t = useComposerText()
  const key: Accessor<ComposerKey> = () => props.composerKey
  createEffect(on(key, (current) => onCleanup(store.retain(current))))
  const late: Late = {}
  const refs = createComposerRefs()
  const selection = createHarnessSelection(props, store, key)
  const working = createMemo(() => sessionWorking(props.view))
  const goalAvailable = createMemo(() => (selection.harness()?.goalMode ?? "none") !== "none")
  const [query, setQuery] = createSignal<SuggestionQuery>({ kind: "closed" })
  const [dragging, setDragging] = createSignal<DraggingType>(null)
  const registries = useShellRegistries()
  const suggestions = createSuggestions({ registries, placementId: () => props.placementId, query, goalAvailable, goalTitle: () => t("composer.action.goal") })
  const send = createSendFor(props, store, key, selection, late)
  const reader = createReaderFor({ props, store, key, refs, selection, setDragging, late })
  const controller = createControllerFor({ key, store, refs, working, suggestions, send })
  late.controller = controller
  createEffect(() => setQuery(controller.suggestionQuery()))
  const draft = () => store.draft(key())
  const shared = { t, key, store, refs, send, reader, suggestions, controller, dragging, draft, working, goalAvailable }
  return {
    ...shared,
    harness: selection.harness,
    harnesses: selection.harnesses,
    selection: selection.selection,
    images: createMemo(() => promptImages(draft().prompt)),
    attachments: () => store.attachments(key()),
    disabled: () => props.readOnly === true || selection.harness()?.available === false,
  }
}

export type ComposerSetup = ReturnType<typeof createComposer>
