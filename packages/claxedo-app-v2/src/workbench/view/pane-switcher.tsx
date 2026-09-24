import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { useWorkbench } from "../provider"
import { createContentTitle } from "./content-title"

function SwitcherItem(props: { readonly contentId: string; readonly selected: boolean; readonly onSelect: () => void }): JSX.Element {
  const title = createContentTitle(useWorkbench(), () => props.contentId)
  return (
    <DropdownMenu.Item class="workbench-switcher-item" data-selected={props.selected ? "true" : undefined} onSelect={props.onSelect}>
      {title() ?? props.contentId}
    </DropdownMenu.Item>
  )
}

export function WorkbenchPaneSwitcher(): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  const focused = () => wb.selectors.focusedContent()
  const focusedTitle = createContentTitle(wb, focused)

  return (
    <Show when={wb.layout().contentIds.length > 0}>
      <DropdownMenu>
        <DropdownMenu.Trigger class="workbench-switcher-trigger" aria-label={t("workbench.switch")} data-testid="pane-switcher">
          <span class="workbench-switcher-title">{focusedTitle() ?? t("workbench.empty")}</span>
          <span aria-hidden="true" class="workbench-switcher-caret">▾</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="workbench-switcher-menu">
            <For each={wb.layout().contentIds}>
              {(contentId) => (
                <SwitcherItem contentId={contentId} selected={focused() === contentId} onSelect={() => wb.navigation.show(contentId)} />
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
