import { For, onCleanup, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useDragSource } from "../drag/drag-source"
import { dictionary } from "../i18n"
import { useWorkbench } from "../provider"
import { createContentTitle } from "./content-title"

function Tab(props: { contentId: string }): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  const contentTitle = createContentTitle(wb, () => props.contentId)
  const title = () => contentTitle() ?? props.contentId
  const selected = () => wb.selectors.focusedContent() === props.contentId

  return (
    <div
      class="workbench-tab"
      role="presentation"
      data-selected={selected() ? "true" : undefined}
      data-workspace-tab-kind={wb.content(props.contentId)?.kind.kind}
      ref={(el) => {
        onCleanup(useDragSource(wb.drag, el, { contentId: () => props.contentId, sourceKind: "tab", label: title, touchAction: "pan-x" }))
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected()}
        tabindex={selected() ? 0 : -1}
        class="workbench-tab-button"
        aria-keyshortcuts="Delete"
        onClick={() => wb.navigation.show(props.contentId)}
        onAuxClick={(event) => {
          if (event.button === 1) wb.closeContent(props.contentId)
        }}
        onKeyDown={(event) => {
          if (event.key === "Delete") wb.closeContent(props.contentId)
        }}
      >
        <span class="workbench-tab-title">{title()}</span>
      </button>
      <button
        type="button"
        class="workbench-tab-close"
        aria-hidden="true"
        tabindex="-1"
        title={t("workbench.closeTab", { title: title() })}
        data-testid="workspace-tab-close"
        onClick={() => wb.closeContent(props.contentId)}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  )
}

export function WorkbenchTabs(): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  return (
    <Show when={wb.layout().contentIds.length > 0}>
      <div class="workbench-tabs" role="tablist" aria-label={t("workbench.tabs")} data-testid="workbench-tabs">
        <For each={wb.layout().contentIds}>{(contentId) => <Tab contentId={contentId} />}</For>
      </div>
    </Show>
  )
}
