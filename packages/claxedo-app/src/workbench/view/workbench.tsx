import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { collapsePaneRects, isCollapsedWidth } from "../collapse-projection"
import { handoverPresence } from "../handover"
import { createWorkbenchDropTarget } from "../drag/drop-target"
import { DropTargetOverlay } from "../drag/drop-target-overlay"
import { workbenchDictionary } from "../i18n"
import { useWorkbench } from "../provider"
import { computePaneRects } from "../reducers/tree-helpers"
import type { KeyMap } from "../types"
import "../workbench.css"
import { ContentSlot } from "./content-slot"
import { createContentIndex } from "./content-index"
import { Divider } from "./divider"
import { rectStyle } from "./geometry"
import { useWorkbenchChords } from "./keyboard-chords"
import { createMountedContents } from "./mount-policy"
import { PaneChrome } from "./pane-chrome"

export type WorkbenchProps = {
  readonly renderEmpty?: () => JSX.Element | undefined
  readonly keyMap?: Partial<KeyMap>
  readonly onCloseFocusedPane?: (paneId: string, contentId: string | null) => void
}

function useCollapsed(root: () => HTMLElement | undefined, split: () => boolean) {
  const [collapsed, setCollapsed] = createSignal(false)
  createEffect(() => {
    const el = root()
    if (!el || !split()) {
      setCollapsed(false)
      return
    }
    const measure = () => setCollapsed(isCollapsedWidth(el.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })
  return collapsed
}

export function Workbench(props: WorkbenchProps): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(workbenchDictionary)
  let rootEl: HTMLDivElement | undefined
  const split = createMemo(() => wb.layout().panes.length > 1)
  const collapsed = useCollapsed(() => rootEl, split)
  const trueRects = createMemo(() => computePaneRects(wb.layout().split.root))
  const displayRects = createMemo(() => (collapsed() ? collapsePaneRects(wb.layout()) : trueRects()))
  const index = createContentIndex(wb.layout, displayRects)
  const mounted = createMountedContents(wb.layout, index.assigned)
  const handover = handoverPresence(wb.handing, index.isDisplayed)
  useWorkbenchChords({ wb, keyMap: props.keyMap, onCloseFocusedPane: props.onCloseFocusedPane })
  const dropTarget = createWorkbenchDropTarget({
    drag: wb.drag,
    root: () => rootEl,
    accepts: wb.split.accepts,
    commitDrop: (paneId, edge, contentId) => {
      if (wb.layout().contentIds.includes(contentId)) wb.split.split(paneId, edge, contentId)
    },
  })
  const rootSplit = createMemo(() => {
    const root = wb.layout().split.root
    return root && root.t === "split" ? root : null
  })
  const paneStyle = (paneId: string) => rectStyle(displayRects().get(paneId))
  const empty = () => <div data-testid="empty" class="workbench-empty">{props.renderEmpty?.() ?? t("workbench.empty")}</div>

  return (
    <div ref={rootEl} data-testid="workbench-root" class="workbench-root" tabindex="-1">
      <Show when={wb.layout().panes.length > 0} fallback={empty()}>
        <div class="workbench-layer">
          <For each={wb.layout().panes}>
            {(pane) => (
              <div
                data-testid={`pane-${pane.id}`}
                data-pane-id={pane.id}
                class="workbench-pane"
                style={paneStyle(pane.id)}
                onMouseDown={() => wb.split.focus(pane.id)}
              >
                <Show when={!pane.contentId}>{empty()}</Show>
              </div>
            )}
          </For>
          <Show when={rootSplit()}>{(split) => <Divider split={split()} root={() => rootEl} />}</Show>
        </div>
        <div class="workbench-layer">
          <For each={mounted()}>
            {(contentId) => (
              <ContentSlot
                contentId={contentId}
                paneOf={index.paneOf}
                presence={handover.presence}
                heldBy={handover.heldBy}
                holds={wb.holds}
                displayRects={displayRects}
              />
            )}
          </For>
        </div>
        <div class="workbench-layer">
          <For each={wb.layout().panes}>
            {(pane) => <PaneChrome pane={pane} style={paneStyle(pane.id)} closable={wb.layout().panes.length > 1} />}
          </For>
          <Show when={dropTarget()}>
            {(target) => (
              <div data-testid={`drop-target-${target().paneId}`} class="workbench-drop-target" style={paneStyle(target().paneId)}>
                <DropTargetOverlay edge={target().edge} />
              </div>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )
}
