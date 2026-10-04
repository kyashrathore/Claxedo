import { For, Match, Show, Switch, type JSX } from "solid-js"
import { Button } from "@/ui"
import { usePluginsText } from "../i18n"
import { usePluginHost } from "../provider"
import { PluginRow } from "./plugin-row"
import type { LiveListState } from "../live/list-state"
import "./plugins.css"

function failedReason(state: LiveListState): string | undefined {
  return state.kind === "failed" ? state.reason : undefined
}

export function PluginsSettings(): JSX.Element {
  const host = usePluginHost()
  const t = usePluginsText()
  return (
    <div class="plugins-settings">
      <p class="plugins-settings-description">{t("plugins.settings.description")}</p>
      <p class="plugins-settings-description">{t(host.platform === "desktop" ? "plugins.settings.trust.desktop" : "plugins.settings.trust.web")}</p>
      <Show when={host.safeMode()}>
        <div role="status" class="plugins-settings-safe-mode">
          <span>{t("plugins.safeMode")}</span>
          <Button type="button" variant="neutral" size="small" onClick={() => host.leaveSafeMode()}>
            {t("plugins.safeMode.leave")}
          </Button>
        </div>
      </Show>
      <Switch>
        <Match when={host.liveList().kind === "notOwner"}>
          <p role="status">{t("plugins.list.notOwner")}</p>
        </Match>
        <Match when={failedReason(host.liveList())}>{(reason) => <p role="alert">{t("plugins.list.failed", { reason: reason() })}</p>}</Match>
      </Switch>
      <Show when={host.plugins().length > 0} fallback={<p>{t("plugins.settings.empty")}</p>}>
        <ul class="plugins-settings-list" aria-label={t("plugins.settings.title")}>
          <For each={host.plugins()}>{(plugin) => <PluginRow plugin={plugin} />}</For>
        </ul>
      </Show>
    </div>
  )
}
