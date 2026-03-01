/**
 * GenericFlatPaneRenderer
 *
 * Renders a multi-pane layout using absolute-positioned leaves from
 * computeLeafRects() and resize handles from computeSplitHandles().
 * Same pattern as the terminal FlatPaneRenderer.
 */

import { For, createMemo, createEffect, on } from "solid-js"
import { useClaxedoLayout } from "../../context/claxedo-layout"
import { GenericLeafNode } from "./generic-leaf-node"
import { requestTerminalFitOnPaneFocus } from "./terminal-fit"

export function GenericFlatPaneRenderer(props: { tabId: string; groupId: string }) {
  const claxedo = useClaxedoLayout()
  const leaves = createMemo(() => claxedo.select.multiPaneLeafView(props.tabId))
  const handles = createMemo(() => claxedo.select.multiPaneSplitHandles(props.tabId))
  const leafIds = createMemo(() => leaves().map((leaf) => leaf.id))
  const leafMap = createMemo(() => new Map(leaves().map((leaf) => [leaf.id, leaf] as const)))

  const isOnlyLeaf = createMemo(() => leafIds().length <= 1)
  const focusedLeaf = createMemo(() => leaves().find((leaf) => leaf.focused))

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
    <div class="relative size-full">
      <For each={leafIds()}>
        {(leafId) => {
          const leaf = createMemo(() => leafMap().get(leafId))

          return (
            <div
              class="absolute overflow-hidden border-b border-l border-r border-border-weaker-base"
              classList={{ hidden: leaf()?.hidden ?? false }}
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
                isOnlyLeaf={isOnlyLeaf}
                onClose={() => claxedo.dispatch({ type: "PaneCloseRequested", tabId: props.tabId, leafId })}
                onFocus={() => claxedo.dispatch({ type: "PaneFocusRequested", tabId: props.tabId, leafId })}
              />
            </div>
          )
        }}
      </For>

      {/* Resize handles */}
      <For each={handles()}>
        {(handle) => (
          <div
            class="absolute z-10"
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
    </div>
  )
}
