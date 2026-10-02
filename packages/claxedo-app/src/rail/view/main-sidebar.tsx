import { For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { sessionPath, settingsPath, useShellRoute } from "@/shell"
import { railDictionary } from "../i18n"
import { AccountCard, USAGE_SECTION } from "./account-card"
import { GlobalNavigation } from "./global-navigation"
import { ProjectTree } from "./project-tree"
import { useServer } from "@/server"
import { ClaxedoIcon as Icon, Tooltip } from "@/ui"

function UsageButton(): JSX.Element {
  const t = useTranslator(railDictionary)
  const routing = useShellRoute()
  return (
    <Tooltip value={t("rail.account.usage")}>
      <button
        type="button"
        aria-label={t("rail.account.usage")}
        data-testid="rail-usage"
        class="flex size-[var(--sidebar-row-height)] shrink-0 items-center justify-center rounded-[var(--sidebar-row-radius)] text-icon-weak-base transition-colors hover:bg-[var(--row-surface-hover)] hover:text-icon-base"
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
        <SharedSessions />
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

function SharedSessions() {
  const server = useServer()
  const routing = useShellRoute()
  const refresh = () => void server.sharedSessions.refresh().catch(() => undefined)
  onMount(() => {
    if (!server.sharedSessions.enabled) return
    const timer = setInterval(refresh, 30_000)
    window.addEventListener("focus", refresh)
    onCleanup(() => { clearInterval(timer); window.removeEventListener("focus", refresh) })
  })
  return (
    <Show when={server.sharedSessions.enabled}>
      <section data-testid="shared-sessions" aria-label="Shared with me" class="flex flex-col px-2.5 py-2 gap-1">
        <div class="flex items-center justify-between px-1.5">
          <h2 class="sidebar-section-label">Shared with me</h2>
          <button type="button" aria-label="Refresh shared sessions" onClick={refresh} class="text-12-regular text-text-weak">Refresh</button>
        </div>
        <Show when={server.sharedSessions.error()}><p role="alert" class="text-12-regular text-text-weak">Shared sessions could not be read. Refresh to try again.</p></Show>
        <For each={server.sharedSessions.list()}>
          {(row) => (
            <button type="button" data-testid="shared-session-row" data-session-id={row.ref.sessionId}
              class="flex flex-col items-start rounded px-2 py-1.5 text-left hover:bg-[var(--row-surface-hover)]"
              onClick={() => routing.navigate(sessionPath(row.ref))}>
              <span class="w-full truncate text-12-regular text-text-base">{row.title}</span>
              <span class="text-12-regular text-text-weak">{row.ownerName} · {row.level}</span>
            </button>
          )}
        </For>
      </section>
    </Show>
  )
}
