/**
 * GenericFlatPaneRenderer
 *
 * Renders a multi-pane layout using absolute-positioned leaves from
 * computeLeafRects() and resize handles from computeSplitHandles().
 * Same pattern as the terminal FlatPaneRenderer.
 */

import { For, Show, createMemo, createEffect, on } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/icon"
import { useClaxedoLayout } from "../../context/claxedo-layout"
import { GenericLeafNode } from "./generic-leaf-node"
import { FloatingSessionOverlay } from "./floating-session-overlay"
import { requestTerminalFitOnPaneFocus } from "./terminal-fit"
import { createMultiPaneInteractions } from "./pane-interactions"

export function GenericFlatPaneRenderer(props: { tabId: string; groupId: string }) {
  const claxedo = useClaxedoLayout()
  const leaves = createMemo(() => claxedo.select.multiPaneLeafView(props.tabId))
  const handles = createMemo(() => claxedo.select.multiPaneSplitHandles(props.tabId))
  const leafIds = createMemo(() => leaves().map((leaf) => leaf.id))
  const leafMap = createMemo(() => new Map(leaves().map((leaf) => [leaf.id, leaf] as const)))

  const isOnlyLeaf = createMemo(() => leafIds().length <= 1)
  const focusedLeaf = createMemo(() => leaves().find((leaf) => leaf.focused))

  const { moveState, overState, dragPos, dragActive, startMove } = createMultiPaneInteractions({
    tabId: props.tabId,
    claxedo,
  })

  /** Title of the pane being dragged, for the floating preview. */
  const dragTitle = createMemo(() => {
    const m = moveState()
    if (!m) return ""
    const leaf = leafMap().get(m.id)
    return leaf?.title ?? leaf?.content?.type ?? "Pane"
  })

  createEffect(
    on(
      focusedLeaf,
      (leaf) => {
        if (!leaf) return
        const type = leaf.content?.type
        requestTerminalFitOnPaneFocus({ type })
      },
      { defer: true },
    ),
  )

  return (
    <div class="relative size-full max-md:flex max-md:flex-col">
      {/* Mobile pane tab bar — only shown when multiple panes exist */}
      <Show when={!isOnlyLeaf()}>
        <div class="hidden max-md:flex shrink-0 border-b border-border-weaker-base bg-background-stronger/80 overflow-x-auto">
          <For each={leafIds()}>
            {(leafId) => {
              const leaf = createMemo(() => leafMap().get(leafId))
              const title = createMemo(() => leaf()?.title ?? leaf()?.content?.type ?? "Pane")
              return (
                <button
                  type="button"
                  class="px-3 py-1.5 text-[11px] font-medium whitespace-nowrap border-r border-border-weaker-base/50 transition-colors"
                  classList={{
                    "text-text-strong bg-background-base": leaf()?.focused,
                    "text-text-weak hover:text-text-base hover:bg-surface-base-hover": !leaf()?.focused,
                  }}
                  onClick={() => claxedo.dispatch({ type: "PaneFocusRequested", tabId: props.tabId, leafId })}
                >
                  {title()}
                </button>
              )
            }}
          </For>
        </div>
      </Show>
      <div class="relative size-full max-md:flex-1 max-md:min-h-0">
      <For each={leafIds()}>
        {(leafId) => {
          const leaf = createMemo(() => leafMap().get(leafId))

          return (
            <div
              class="absolute overflow-hidden border-b border-l border-r border-border-weaker-base"
              classList={{
                hidden: leaf()?.hidden ?? false,
                "max-md:!hidden": !isOnlyLeaf() && !(leaf()?.focused),
                "max-md:!inset-0 max-md:!w-full max-md:!h-full": !isOnlyLeaf() && (leaf()?.focused ?? false),
              }}
              style={{
                top: leaf()?.hidden ? "0" : `${(leaf()?.rect.top ?? 0) * 100}%`,
                left: leaf()?.hidden ? "0" : `${(leaf()?.rect.left ?? 0) * 100}%`,
                width: leaf()?.hidden ? "0" : `${(leaf()?.rect.width ?? 1) * 100}%`,
                height: leaf()?.hidden ? "0" : `${(leaf()?.rect.height ?? 1) * 100}%`,
                ...(leaf()?.zoomed ? { top: "0", left: "0", width: "100%", height: "100%" } : {}),
              }}
            >
              <GenericLeafNode
                tabId={props.tabId}
                groupId={props.groupId}
                leafId={leafId}
                content={() => leaf()?.content}
                isFocused={() => leaf()?.focused ?? false}
                isZoomed={() => leaf()?.zoomed ?? false}
                isFloating={() => leaf()?.floating ?? false}
                isOnlyLeaf={isOnlyLeaf}
                isDragging={() => moveState()?.id === leafId}
                isDragOver={() => overState() === leafId}
                isDragActive={dragActive}
                onStartMove={(e) => startMove(e, leafId)}
                onClose={() => claxedo.dispatch({ type: "PaneCloseRequested", tabId: props.tabId, leafId })}
                onFocus={() => claxedo.dispatch({ type: "PaneFocusRequested", tabId: props.tabId, leafId })}
              />
            </div>
          )
        }}
      </For>

      {/* Floating session overlay */}
      <For each={leaves().filter((l) => l.floating)}>
        {(leaf) => (
          <FloatingSessionOverlay
            tabId={props.tabId}
            groupId={props.groupId}
            leafId={leaf.id}
            content={() => leaf.content}
            onDock={() => claxedo.dispatch({ type: "PaneUnfloatRequested", tabId: props.tabId })}
            onClose={() => claxedo.dispatch({ type: "PaneCloseRequested", tabId: props.tabId, leafId: leaf.id })}
          />
        )}
      </For>

      {/* Resize handles */}
      <For each={handles()}>
        {(handle) => (
          <div
            class="absolute z-10 max-md:hidden"
            style={{
              ...(handle.dir === "v"
                ? {
                    top: `${handle.top * 100}%`,
                    left: `calc(${handle.left * 100}% - 3px)`,
                    width: "6px",
                    height: `${handle.height * 100}%`,
                    cursor: "col-resize",
                  }
                : {
                    top: `calc(${handle.top * 100}% - 3px)`,
                    left: `${handle.left * 100}%`,
                    width: `${handle.width * 100}%`,
                    height: "6px",
                    cursor: "row-resize",
                  }),
            }}
            onPointerDown={(event) => {
              const parentRect = (event.currentTarget as HTMLElement).parentElement?.getBoundingClientRect()
              if (!parentRect) return
              const start = handle.dir === "v" ? event.clientX : event.clientY
              const initSize = handle.position

              const move = (e: PointerEvent) => {
                const delta = (handle.dir === "v" ? e.clientX : e.clientY) - start
                const span = handle.dir === "v" ? parentRect.width : parentRect.height
                if (!span) return
                claxedo.dispatch({
                  type: "PaneResizeRequested",
                  tabId: props.tabId,
                  path: handle.path,
                  size: initSize + delta / span,
                })
              }

              const up = () => {
                window.removeEventListener("pointermove", move)
                window.removeEventListener("pointerup", up)
              }

              window.addEventListener("pointermove", move)
              window.addEventListener("pointerup", up)
            }}
          />
        )}
      </For>

      {/* Floating drag preview — follows cursor while dragging */}
      <Show when={dragActive() && dragPos()}>
        {(pos) => (
          <Portal>
            <div
              class="fixed z-50 pointer-events-none flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background-stronger border border-border-weak-base shadow-lg"
              style={{
                left: `${pos().x + 12}px`,
                top: `${pos().y - 14}px`,
              }}
            >
              <Icon name="chevron-grabber-vertical" size="small" class="text-icon-weak-base" />
              <span class="text-[12px] font-medium text-text-base whitespace-nowrap max-w-[200px] overflow-hidden text-ellipsis">
                {dragTitle()}
              </span>
            </div>
          </Portal>
        )}
      </Show>
      </div>
    </div>
  )
}
