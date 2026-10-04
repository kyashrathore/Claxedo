import { onCleanup, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useDragSource } from "../drag/drag-source"
import { workbenchDictionary } from "../i18n"
import { useWorkbench } from "../provider"
import type { Pane } from "../types"
import { createContentTitle } from "./content-title"
import { ClaxedoIcon as Icon } from "@/ui"

export function PaneChrome(props: { pane: Pane; style: JSX.CSSProperties; closable: boolean }): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(workbenchDictionary)
  const contentTitle = createContentTitle(wb, () => props.pane.contentId)
  const title = () => contentTitle() ?? ""

  return (
    <Show when={props.pane.contentId}>
      {(contentId) => (
        <div class="workbench-pane-chrome" data-testid={`pane-chrome-${props.pane.id}`} style={props.style}>
          <Show when={wb.splittable(contentId())}>
            <div
              data-testid={`pane-handle-${props.pane.id}`}
              aria-hidden="true"
              title={t("workbench.dragPane")}
              class="absolute left-2 top-2 flex size-5 cursor-grab items-center justify-center rounded border border-border-weak-base/35 bg-background-base/55 text-icon-weak-base opacity-0 backdrop-blur-sm transition-opacity duration-100 hover:opacity-100 active:cursor-grabbing"
              style={{ "pointer-events": "auto" }}
              ref={(el) => {
                onCleanup(useDragSource(wb.drag, el, { contentId, sourceKind: "workbench-pane", label: title, touchAction: "none" }))
              }}
            >
              <Icon name="three-dots" size="small" />
            </div>
          </Show>
          <Show when={props.closable}>
            <button
              type="button"
              aria-label={t("workbench.closePane")}
              data-testid={`pane-close-${props.pane.id}`}
              draggable={false}
              class="absolute right-2 top-2 flex size-5 items-center justify-center rounded border border-border-weak-base/35 bg-background-base/55 p-0 text-icon-weak-base opacity-35 backdrop-blur-sm outline-none transition-[opacity,background-color,color,border-color] duration-100 hover:border-border-base/70 hover:bg-surface-base-hover/90 hover:text-icon-base hover:opacity-100 focus-visible:border-border-base/70 focus-visible:bg-surface-base-hover/90 focus-visible:text-icon-base focus-visible:opacity-100"
              style={{ "pointer-events": "auto" }}
              onPointerDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                wb.split.close(props.pane.id, { destroyContent: false })
              }}
            >
              <Icon name="close-small" size="small" />
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}
