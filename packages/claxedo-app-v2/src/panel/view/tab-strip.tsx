import { For, type JSX } from "solid-js"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon } from "@/ui"
import { filePathFromTab } from "../focus"
import { dictionary } from "../i18n"
import { usePanel } from "../store"
import { createReviewWorkspaceTabPresentation } from "../tab-presentation"
import { ReviewWorkspaceTabButton } from "./tab-button"

function AddTabMenu(): JSX.Element {
  const t = useTranslator(dictionary)
  const panel = usePanel()
  return (
    <DropdownMenu gutter={4} placement="bottom-start">
      <DropdownMenu.Trigger
        class="flex size-6 items-center justify-center rounded-sm text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
        aria-label={t("panel.addTab")}
        title={t("panel.addTab")}
      >
        <Icon name="plus-small" size="small" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="z-[200]">
          <DropdownMenu.Item onSelect={() => panel.show({ kind: "browser" })}>
            <Icon name="globe" size="small" />
            {t("panel.add.browser")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function PanelTabStrip(): JSX.Element {
  const panel = usePanel()
  const t = useTranslator(dictionary)
  const presentation = createReviewWorkspaceTabPresentation({
    reviewLabel: () => t("panel.tab.review"),
    contextLabel: () => t("panel.tab.context"),
    subagentLabel: () => t("panel.tab.subagent"),
    subagentCloseLabel: () => t("panel.tab.closeSubagent"),
    planLabel: () => t("panel.tab.plan"),
    filePathFromTab,
  })
  return (
    <div
      data-testid="workspace-tab-header"
      class="flex h-9 w-full max-w-full min-w-0 items-center overflow-hidden bg-background-base"
      style={{ width: "100%" }}
    >
      <div
        data-testid="workspace-tab-scroll"
        class="flex h-full min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <For each={panel.tabs()}>
          {(tab) => (
            <ReviewWorkspaceTabButton
              tab={tab}
              selected={panel.activeTab().id === tab.id}
              label={presentation.tabLabel(tab)}
              icon={presentation.tabIcon(tab)}
              iconPx={presentation.tabIconPx(tab)}
              closeLabel={presentation.closeLabel(tab)}
              closable={tab.kind !== "review"}
              onActivate={() => panel.activate(tab.id)}
              onClose={() => panel.closeTab(tab.id)}
            />
          )}
        </For>
        <div data-testid="workspace-tab-actions" class="flex h-full shrink-0 items-center bg-background-base px-1">
          <AddTabMenu />
        </div>
      </div>
    </div>
  )
}
