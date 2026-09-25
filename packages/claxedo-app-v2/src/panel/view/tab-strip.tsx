import { For, Show, type JSX } from "solid-js"
import { useActiveSession } from "@/files"
import { useTranslator } from "@/i18n"
import { DialogSelectFile, useShellRegistries } from "@/shell"
import { ClaxedoIcon as Icon, DropdownMenu, useDialog } from "@/ui"
import { filePathFromTab } from "../focus"
import { dictionary } from "../i18n"
import { usePanel } from "../store"
import { createReviewWorkspaceTabPresentation } from "../tab-presentation"
import { ReviewWorkspaceTabButton } from "./tab-button"

function AddTabMenu(): JSX.Element {
  const t = useTranslator(dictionary)
  const panel = usePanel()
  const session = useActiveSession()
  const registries = useShellRegistries()
  const dialog = useDialog()
  const openFile = (path: string) => panel.show({ kind: "file", path }, { navigator: "files" })
  const hasContext = () => registries.panelViews.list().some((entry) => entry.kind === "context")
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
          <DropdownMenu.Item
            onSelect={() =>
              dialog.show(() => <DialogSelectFile mode="files" placementId={panel.placementId()} onOpenFile={openFile} />)
            }
          >
            <Icon name="document-text" size="small" />
            {t("panel.add.file")}
          </DropdownMenu.Item>
          <Show when={hasContext()}>
            <DropdownMenu.Item
              disabled={!session()}
              onSelect={() => {
                const ref = session()
                if (ref) panel.show({ kind: "context", sessionId: ref.sessionId })
              }}
            >
              <Icon name="circle-half" size="small" />
              {t("panel.tab.context")}
            </DropdownMenu.Item>
          </Show>
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
          <Show when={!panel.phone()}>
            <AddTabMenu />
          </Show>
        </div>
      </div>
    </div>
  )
}
