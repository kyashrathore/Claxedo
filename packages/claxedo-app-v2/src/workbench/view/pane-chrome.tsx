import { onCleanup, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useDragSource } from "../drag/drag-source"
import { dictionary } from "../i18n"
import { useWorkbench } from "../provider"
import type { Pane } from "../types"
import { createContentTitle } from "./content-title"

export function PaneChrome(props: { pane: Pane; style: JSX.CSSProperties; closable: boolean }): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  const contentTitle = createContentTitle(wb, () => props.pane.contentId)
  const title = () => contentTitle() ?? ""

  return (
    <Show when={props.pane.contentId}>
      {(contentId) => (
        <div class="workbench-pane-chrome" data-testid={`pane-chrome-${props.pane.id}`} style={props.style}>
          <div
            data-testid={`pane-handle-${props.pane.id}`}
            aria-hidden="true"
            title={t("workbench.dragPane")}
            class="workbench-pane-grip"
            ref={(el) => {
              onCleanup(useDragSource(wb.drag, el, { contentId, sourceKind: "workbench-pane", label: title, touchAction: "none" }))
            }}
          >
            <span class="workbench-pane-grip-dots" />
          </div>
          <Show when={props.closable}>
            <button
              type="button"
              aria-label={t("workbench.closePane")}
              data-testid={`pane-close-${props.pane.id}`}
              class="workbench-pane-close"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                wb.split.close(props.pane.id, { destroyContent: false })
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}
