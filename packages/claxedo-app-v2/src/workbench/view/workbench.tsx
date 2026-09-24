import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { collapsePaneRects, isCollapsedWidth } from "../collapse-projection"
import { createWorkbenchDropTarget } from "../drag/drop-target"
import { DropTargetOverlay } from "../drag/drop-target-overlay"
import { dictionary } from "../i18n"
import { createSurfaceKeyRouter } from "../keyboard"
import { useWorkbench } from "../provider"
import { computePaneRects } from "../reducers/tree-helpers"
import type { KeyMap } from "../types"
import { ContentSlot } from "./content-slot"
import { createContentIndex } from "./content-index"
import { Divider } from "./divider"
import { rectStyle } from "./geometry"
import { useWorkbenchChords } from "./keyboard-chords"
import { createMountedContents } from "./mount-policy"
import { PaneChrome } from "./pane-chrome"

export type WorkbenchProps = {
  readonly renderEmpty?: () => JSX.Element
  readonly keyMap?: Partial<KeyMap>
  readonly onCloseFocusedPane?: (paneId: string, contentId: string | null) => void
}

function useContainerSize(root: () => HTMLElement | undefined) {
  const [size, setSize] = createSignal({ w: 0, h: 0 })
  onMount(() => {
    const el = root()
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      setSize({ w: rect.width, h: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })
  return size
}

export function Workbench(props: WorkbenchProps): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  let rootEl: HTMLDivElement | undefined
  const containerSize = useContainerSize(() => rootEl)
  const collapsed = createMemo(() => isCollapsedWidth(containerSize().w))
  const trueRects = createMemo(() => computePaneRects(wb.layout().split.root))
  const displayRects = createMemo(() => (collapsed() ? collapsePaneRects(wb.layout()) : trueRects()))
  const index = createContentIndex(wb.layout, displayRects)
  const mounted = createMountedContents(wb.layout, index.assigned)
  const surfaceKeys = createSurfaceKeyRouter(() => wb.layout().focusedPaneId)
  useWorkbenchChords({ wb, keyMap: props.keyMap, surfaceKeys, onCloseFocusedPane: props.onCloseFocusedPane })
  const dropTarget = createWorkbenchDropTarget({
    drag: wb.drag,
    root: () => rootEl,
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
    <div ref={rootEl} data-testid="workbench-root" class="workbench-root" data-collapsed={collapsed() ? "true" : undefined} tabindex="-1">
      <Show when={wb.layout().panes.length > 0} fallback={empty()}>
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
        <Show when={!collapsed() && rootSplit()}>{(split) => <Divider split={split()} root={() => rootEl} />}</Show>
        <For each={mounted()}>
          {(contentId) => (
            <ContentSlot
              contentId={contentId}
              paneOf={index.paneOf}
              displayed={index.isDisplayed}
              displayRects={displayRects}
              surfaceKeys={surfaceKeys}
            />
          )}
        </For>
        <Show when={!collapsed()}>
          <For each={wb.layout().panes}>
            {(pane) => <PaneChrome pane={pane} style={paneStyle(pane.id)} closable={wb.layout().panes.length > 1} />}
          </For>
        </Show>
        <Show when={dropTarget()}>
          {(target) => (
            <div data-testid={`drop-target-${target().paneId}`} class="workbench-drop-target" style={paneStyle(target().paneId)}>
              <DropTargetOverlay edge={target().edge} />
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
