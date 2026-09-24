import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { settingsPath, useShellRoute } from "@/shell"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { railDictionary } from "../i18n"
import { AccountCard, USAGE_SECTION } from "./account-card"
import { GlobalNavigation } from "./global-navigation"
import { ProjectTree } from "./project-tree"
import { ClaxedoIcon as Icon } from "@/ui"

function UsageButton(): JSX.Element {
  const t = useTranslator(railDictionary)
  const routing = useShellRoute()
  return (
    <Tooltip value={t("rail.account.usage")}>
      <button
        type="button"
        aria-label={t("rail.account.usage")}
        data-testid="rail-usage"
        class="flex size-9 shrink-0 items-center justify-center rounded-md text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
        onClick={() => routing.navigate(settingsPath(USAGE_SECTION))}
      >
        <Icon name="gauge" size="small" />
      </button>
    </Tooltip>
  )
}

export function MainSidebar(): JSX.Element {
  let foot: HTMLDivElement | undefined
  return (
    <>
      <div
        class="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden rail-sidebar-scroll"
        style={{ "scrollbar-width": "thin", "scrollbar-color": "var(--scrollbar-thumb) transparent" }}
      >
        <GlobalNavigation />
        <ProjectTree />
      </div>
      <div class="px-2.5 py-2">
        <div ref={foot} class="flex items-center gap-1 border-t border-border-weak-base/15 pt-2">
          <div class="min-w-0 flex-1">
            <AccountCard anchor={() => foot} />
          </div>
          <UsageButton />
        </div>
      </div>
    </>
  )
}
