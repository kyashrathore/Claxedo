import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { PlacementId } from "@/server"
import { useServer } from "@/server"
import type { SessionView } from "@/session"
import { useDialog } from "@/ui"
import type { ImagePart } from "./model"
import { promptImages } from "./model"
import { useComposerStore, type ComposerKey } from "./store"
import { useShellRegistries } from "@/shell"
import { useComposerText } from "./text"
import { createAttachmentReader, type DraggingType } from "./attachments/reader"
import { createComposerController, createComposerRefs } from "./controller"
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

export function createComposer(props: ComposerProps) {
  const store = useComposerStore()
  const registries = useShellRegistries()
  const server = useServer()
  const dialog = useDialog()
  const t = useComposerText()
  const key: Accessor<ComposerKey> = () => props.composerKey

  createEffect(on(key, (current) => onCleanup(store.retain(current))))

  const refs = createComposerRefs()
  const harnesses = createMemo(() => server.capabilities()?.harnesses ?? [])
  const selection = () => store.selection(key())
  const harness = createMemo(() =>
    props.view ? sessionHarness(harnesses(), props.sessionHarness) : pickHarness(harnesses(), selection().harness),
  )
  const sendSelection = () => (harness() ? selection() : {})

  createEffect(() => {
    const next = selectionFor(harness(), selection())
    if (selectionChanged(next, selection())) store.setSelection(key(), next)
  })

  const working = createMemo(() => {
    const kind = props.view?.status().kind
    return kind === "working" || kind === "retrying" || kind === "recovering"
  })
  const goalAvailable = createMemo(() => (harness()?.goalMode ?? "none") !== "none")
  const [query, setQuery] = createSignal<SuggestionQuery>({ kind: "closed" })
  const [dragging, setDragging] = createSignal<DraggingType>(null)

  const suggestions = createSuggestions({
    registries,
    placementId: () => props.placementId,
    query,
    goalAvailable,
    goalTitle: () => t("composer.action.goal"),
  })

  let focus = () => {}
  const send = createComposerSend({
    key,
    store,
    mode: () => controller.state.mode,
    selection: sendSelection,
    goalMode: () => harness()?.goalMode,
    view: () => props.view,
    createSession: props.createSession,
    afterAccepted: (view) => {
      controller.resetHistory()
      props.afterAccepted?.(view)
    },
    focusEditor: () => focus(),
  })

  const reader = createAttachmentReader({
    key,
    store,
    editor: refs.editor,
    zone: refs.root,
    isDialogActive: () => !!dialog.active,
    target: () => {
      const current = harness()
      return { harness: current ? { id: current.id, name: current.name } : undefined, workspace: props.attachmentWorkspace }
    },
    setDraggingType: setDragging,
    focusEditor: () => focus(),
  })

  const runCommand = (item: SlashItem) => {
    if (item.kind === "command") void item.entry.run()
  }

  const controller = createComposerController({
    key,
    store,
    refs,
    working,
    atItems: suggestions.atItems,
    slashItems: suggestions.slashItems,
    submit: () => void send.send(),
    stop: () => void send.stop(),
    edited: send.edited,
    armGoal: send.armGoal,
    runCommand,
  })
  focus = () => controller.focusEditor()
  createEffect(() => setQuery(controller.suggestionQuery()))

  const draft = () => store.draft(key())

  return {
    t,
    key,
    store,
    refs,
    harness,
    harnesses,
    selection,
    working,
    goalAvailable,
    send,
    reader,
    suggestions,
    controller,
    dragging,
    draft,
    images: createMemo(() => promptImages(draft().prompt)),
    attachments: () => store.attachments(key()),
    disabled: () => props.readOnly === true || harness()?.available === false,
  }
}

export type ComposerSetup = ReturnType<typeof createComposer>
