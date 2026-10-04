import { For, Match, Show, Switch, type JSX } from "solid-js"
import { useI18n } from "@/i18n"
import type { SettingsSection } from "@/shell"
import { Button } from "@/ui"
import { usePluginsText } from "../i18n"
import { usePluginHost } from "../provider"
import { PluginRow } from "./plugin-row"
import { PluginWarning } from "./plugin-warning"
import type { LiveListState } from "../live/list-state"
import "./plugins.css"

function failedReason(state: LiveListState): string | undefined {
  return state.kind === "failed" ? state.reason : undefined
}

function PluginsSettings(): JSX.Element {
  const host = usePluginHost()
  const t = usePluginsText()
  return (
    <section class="plugins-settings" aria-labelledby="plugins-settings-title">
      <h2 id="plugins-settings-title" class="plugins-settings-title">
        {t("plugins.settings.title")}
      </h2>
      <p class="plugins-settings-description">{t("plugins.settings.description")}</p>
      <PluginWarning platform={host.platform} />
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
        <ul class="plugins-settings-list" aria-labelledby="plugins-settings-title">
          <For each={host.plugins()}>{(plugin) => <PluginRow plugin={plugin} />}</For>
        </ul>
      </Show>
    </section>
  )
}

export const pluginsSettingsSection: SettingsSection = {
  id: "app-plugins",
  title: () => useI18n().t("plugins.settings.title"),
  group: "app",
  order: 90,
  view: PluginsSettings,
}
