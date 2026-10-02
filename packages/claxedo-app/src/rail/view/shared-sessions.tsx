import { For, onCleanup, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { sessionPath, useShellRoute } from "@/shell"
import { ClaxedoIcon as Icon } from "@/ui"
import { railDictionary } from "../i18n"

export function SharedSessions(): JSX.Element {
  const server = useServer()
  const routing = useShellRoute()
  const t = useTranslator(railDictionary)
  const shared = server.sharedSessions
  const refresh = () => void shared.refresh()
  if (shared.enabled) {
    window.addEventListener("focus", refresh)
    onCleanup(() => window.removeEventListener("focus", refresh))
  }
  return (
    <Show when={shared.enabled && (shared.list().length > 0 || shared.error())}>
      <section data-testid="shared-sessions" aria-label={t("rail.shared")} class="flex flex-col gap-0.5 px-2.5 py-2">
        <div class="flex items-center justify-between px-1.5">
          <div class="sidebar-section-label">{t("rail.shared")}</div>
          <button
            type="button"
            aria-label={t("rail.shared.refresh")}
            class="flex size-5 items-center justify-center rounded text-icon-weak-base hover:text-icon-base"
            onClick={refresh}
          >
            <Icon name="reset" size="small" />
          </button>
        </div>
        <Show when={shared.error()}>
          <p role="alert" class="px-1.5 text-12-regular text-text-weak">{t("rail.shared.failed")}</p>
        </Show>
        <For each={shared.list()}>
          {(row) => (
            <button
              type="button"
              data-testid="shared-session-row"
              data-session-id={row.ref.sessionId}
              class="flex flex-col items-start rounded-[var(--sidebar-row-radius)] px-2 py-1.5 text-left hover:bg-[var(--row-surface-hover)]"
              onClick={() => routing.navigate(sessionPath(row.ref))}
            >
              <span class="w-full truncate text-12-regular text-text-base">{row.title || t("rail.untitled")}</span>
              <span class="text-12-regular text-text-weak">{t(`rail.shared.${row.level}`, { owner: row.ownerName ?? "" })}</span>
            </button>
          )}
        </For>
      </section>
    </Show>
  )
}
