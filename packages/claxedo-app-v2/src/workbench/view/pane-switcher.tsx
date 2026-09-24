import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { useWorkbench } from "../provider"

export function WorkbenchPaneSwitcher(): JSX.Element {
  const wb = useWorkbench()
  const t = useTranslator(dictionary)
  const titleOf = (contentId: string) => {
    const pane = wb.content(contentId)
    return pane ? pane.kind.title(pane.state as never) : contentId
  }
  const focused = () => wb.selectors.focusedContent()

  return (
    <Show when={wb.layout().contentIds.length > 0}>
      <DropdownMenu>
        <DropdownMenu.Trigger class="workbench-switcher-trigger" aria-label={t("workbench.switch")} data-testid="pane-switcher">
          <span class="workbench-switcher-title">{focused() ? titleOf(focused()!) : t("workbench.empty")}</span>
          <span aria-hidden="true" class="workbench-switcher-caret">▾</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="workbench-switcher-menu">
            <For each={wb.layout().contentIds}>
              {(contentId) => (
                <DropdownMenu.Item
                  class="workbench-switcher-item"
                  data-selected={focused() === contentId ? "true" : undefined}
                  onSelect={() => wb.navigation.show(contentId)}
                >
                  {titleOf(contentId)}
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  )
}
