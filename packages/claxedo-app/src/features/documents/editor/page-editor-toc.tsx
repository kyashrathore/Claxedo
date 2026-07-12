/**
 * Right-side table-of-contents rail for the page editor: hover menu with
 * heading titles plus the compact mark rail.
 *
 * Pure presentation over signals/handlers owned by PageEditorLoaded —
 * received as props. Extracted verbatim from page-editor.tsx (Plan 005);
 * markup, classes, and behavior unchanged.
 */

import { Show, For } from "solid-js"
import type { TocMark } from "./page-editor-model"

export type PageEditorTocProps = {
  toc: () => TocMark[]
  activeToc: () => number
  jumpToc: (item: TocMark) => void
  dockEnabled: () => boolean
  dockPosition: () => "left" | "right"
  dockWidth: () => number
}

export function PageEditorToc(props: PageEditorTocProps) {
  return (
    <Show when={props.toc().length > 1}>
      <div
        class="notion-toc-wrap"
        classList={{
          "notion-toc-wrap-side-right": props.dockEnabled() && props.dockPosition() === "right",
        }}
        style={(props.dockEnabled() ? { "--page-side-dock-width": `${props.dockWidth()}px` } : {})}
      >
        <div class="notion-toc-menu">
          <div class="notion-toc-menu-title">Table of contents</div>
          <For each={props.toc().slice(0, 40)}>
            {(item) => (
              <button
                type="button"
                class="notion-toc-menu-item"
                classList={{ "notion-toc-menu-item-active": props.activeToc() === item.order }}
                style={{ "padding-left": `${Math.max(10, 10 + (item.level - 1) * 12)}px` }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.jumpToc(item)}
              >
                {item.title}
              </button>
            )}
          </For>
        </div>

        <div class="notion-toc-rail">
          <For each={props.toc().slice(0, 40)}>
            {(item) => (
              <button
                type="button"
                class="notion-toc-mark"
                classList={{ "notion-toc-mark-active": props.activeToc() === item.order }}
                style={{ width: `${Math.max(14, 26 - (item.level - 1) * 4)}px` }}
                title={item.title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.jumpToc(item)}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
