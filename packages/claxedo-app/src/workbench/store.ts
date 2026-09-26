import { batch, type Accessor } from "solid-js"
import { persistedSignal } from "@/lib/persisted"
import { isRecord } from "@/lib/record"
import type { AnyPaneKind, Json, PaneKind, PaneRoute } from "@/shell"
import { constructWorkbenchState } from "./construct"
import { createDragController, type DragController } from "./drag/pointer-drag"
import { createHandover, type Handing } from "./handover"
import { createLayoutApi, type WorkbenchApi } from "./layout-api"
import { createPaneApi, type PaneApi } from "./pane-api"
import { reducers } from "./reducers/index"
import { createRevealHolds, type RevealHolds } from "./reveal-holds"
import { selectors } from "./selectors"
import type { WorkbenchState } from "./types"
import { validate } from "./validate"

export type { WorkbenchApi } from "./layout-api"

export type PaneContent = { readonly kind: string; readonly state: Json }

export type WorkbenchRecord = {
  readonly layout: WorkbenchState
  readonly contents: Readonly<Record<string, PaneContent>>
}

export type OpenedPane = { readonly contentId: string; readonly kind: AnyPaneKind; readonly state: unknown }

export type WorkbenchStore = WorkbenchApi &
  PaneApi & {
  readonly layout: Accessor<WorkbenchState>
  readonly content: (contentId: string) => OpenedPane | undefined
  readonly open: <State>(kind: PaneKind<State>, state: State, focus?: boolean) => string
  readonly openRoute: (route: PaneRoute, focus?: boolean) => string | undefined
  readonly routeOf: (contentId: string) => PaneRoute | undefined
  readonly closeContent: (contentId: string) => void
  readonly move: (tabId: string, index: number) => void
  readonly onClosed: <State>(kind: PaneKind<State>, listener: (state: State) => void) => () => void
  readonly drag: DragController
  readonly holds: RevealHolds
  readonly handing: Accessor<Handing | undefined>
}

function closeContentReducer(state: WorkbenchState, contentId: string): WorkbenchState {
  const paneId = selectors.contentPane(state, contentId)
  const closed = paneId ? reducers.split.closePane(state, paneId, { destroyContent: true }) : reducers.contents.remove(state, contentId)
  const next = closed.contentRecency[0]
  return closed.panes.length === 0 && next ? reducers.navigation.show(closed, next) : closed
}

function contentKey(kind: { readonly kind: string; readonly singleton?: boolean }, state: Json): string {
  return kind.singleton ? kind.kind : `${kind.kind}:${JSON.stringify(state)}`
}

function readContents(value: unknown): Record<string, PaneContent> {
  const contents: Record<string, PaneContent> = {}
  if (!isRecord(value)) return contents
  for (const [id, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.kind !== "string" || entry.state === undefined) continue
    contents[id] = { kind: entry.kind, state: entry.state as Json }
  }
  return contents
}

function pruned(contents: Readonly<Record<string, PaneContent>>, contentIds: readonly string[]): Record<string, PaneContent> {
  const kept: Record<string, PaneContent> = {}
  for (const id of contentIds) if (contents[id]) kept[id] = contents[id]
  return kept
}

function readWorkbenchRecord(value: unknown): WorkbenchRecord | undefined {
  if (!isRecord(value)) return undefined
  const contents = readContents(value.contents)
  let layout = validate(value.layout)
  for (const id of layout.contentIds) if (!contents[id]) layout = reducers.contents.remove(layout, id)
  return { layout, contents: pruned(contents, layout.contentIds) }
}

function createApply(
  record: Accessor<WorkbenchRecord>,
  setRecord: (update: (current: WorkbenchRecord) => WorkbenchRecord) => void,
  onRemoved: (contents: readonly PaneContent[]) => void,
) {
  let scratch: WorkbenchState | undefined
  let clearQueued = false
  return (mutation: (layout: WorkbenchState) => WorkbenchState) => {
    const current = scratch ?? record().layout
    const next = mutation(current)
    if (next === current) return
    scratch = next
    if (!clearQueued) {
      clearQueued = true
      queueMicrotask(() => {
        scratch = undefined
        clearQueued = false
      })
    }
    const contents = record().contents
    const removed = current.contentIds.flatMap((id) => (next.contentIds.includes(id) || !contents[id] ? [] : [contents[id]]))
    setRecord((r) => ({ layout: next, contents: pruned(r.contents, next.contentIds) }))
    if (removed.length > 0) onRemoved(removed)
  }
}

function createClosedListeners() {
  const listeners = new Map<string, Set<(state: Json) => void>>()
  return {
    notify: (contents: readonly PaneContent[]) => {
      for (const content of contents) for (const listener of listeners.get(content.kind) ?? []) listener(content.state)
    },
    add: <State,>(kind: PaneKind<State>, listener: (state: State) => void) => {
      const decoded = (json: Json) => {
        const state = kind.decode(json)
        if (state !== undefined) listener(state)
      }
      const forKind = listeners.get(kind.kind) ?? new Set()
      forKind.add(decoded)
      listeners.set(kind.kind, forKind)
      return () => {
        forKind.delete(decoded)
      }
    },
  }
}

function createContentReader(record: Accessor<WorkbenchRecord>, kinds: Accessor<readonly AnyPaneKind[]>) {
  const decoded = new Map<string, { json: Json; state: unknown }>()
  const content = (contentId: string): OpenedPane | undefined => {
    const entry = record().contents[contentId]
    if (!entry) return undefined
    const kind = kinds().find((candidate) => candidate.kind === entry.kind)
    if (!kind) return undefined
    const cached = decoded.get(contentId)
    if (cached && cached.json === entry.state) return { contentId, kind, state: cached.state }
    const state = kind.decode(entry.state)
    decoded.set(contentId, { json: entry.state, state })
    return { contentId, kind, state }
  }
  const keyOf = (contentId: string): string | undefined => {
    const opened = content(contentId)
    return opened?.state === undefined ? undefined : contentKey(opened.kind, opened.kind.encode(opened.state as never))
  }
  return { content, keyOf }
}

type Open = <State>(kind: PaneKind<State>, state: State, focus?: boolean) => string

function createOpen(input: {
  readonly record: Accessor<WorkbenchRecord>
  readonly setRecord: (update: (current: WorkbenchRecord) => WorkbenchRecord) => void
  readonly apply: (mutation: (layout: WorkbenchState) => WorkbenchState) => void
  readonly keyOf: (contentId: string) => string | undefined
}): Open {
  return <State,>(kind: PaneKind<State>, state: State, focus = true): string => {
    const encoded = kind.encode(state)
    const key = contentKey(kind, encoded)
    const existing = input.record().contents[key] ? key : input.record().layout.contentIds.find((contentId) => input.keyOf(contentId) === key)
    const id = existing ?? key
    batch(() => {
      input.setRecord((r) => (r.contents[id] && !kind.singleton ? r : { ...r, contents: { ...r.contents, [id]: { kind: kind.kind, state: encoded } } }))
      input.apply((s) => (focus ? reducers.navigation.show(reducers.contents.add(s, id), id) : reducers.contents.add(s, id)))
    })
    return id
  }
}

function openRoute(kinds: readonly AnyPaneKind[], open: Open, route: PaneRoute, focus: boolean): string | undefined {
  for (const kind of kinds) {
    const state = kind.fromRoute?.(route)
    if (state !== undefined) return open(kind as PaneKind<unknown>, state, focus)
  }
  return undefined
}

export function createWorkbenchStore(key: string, kinds: Accessor<readonly AnyPaneKind[]>): WorkbenchStore {
  const [record, setRecord] = persistedSignal<WorkbenchRecord>(
    key,
    { layout: constructWorkbenchState.empty(), contents: {} },
    readWorkbenchRecord,
  )
  const layout = () => record().layout
  const closed = createClosedListeners()
  const apply = createApply(record, setRecord, closed.notify)
  const { content, keyOf } = createContentReader(record, kinds)

  const open = createOpen({ record, setRecord, apply, keyOf })

  const closeContent = (contentId: string) => apply((s) => closeContentReducer(s, contentId))
  const holds = createRevealHolds()
  const handing = createHandover({ layout, revealed: holds.revealed })

  return {
    ...createPaneApi({ layout, content, open, apply, closeContent }),
    layout,
    content,
    open,
    openRoute: (route, focus = true) => openRoute(kinds(), open, route, focus),
    routeOf: (contentId) => {
      const opened = content(contentId)
      return opened?.kind.toRoute?.(opened.state as never)
    },
    closeContent,
    move: (tabId, index) => apply((s) => reducers.contents.reorder(s, tabId, index)),
    onClosed: closed.add,
    drag: createDragController(),
    holds,
    handing,
    ...createLayoutApi(layout, apply, handing),
  }
}
