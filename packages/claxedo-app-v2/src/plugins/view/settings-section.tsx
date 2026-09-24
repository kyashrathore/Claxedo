import { For, Show, type JSX } from "solid-js"
import { useI18n } from "@/i18n"
import type { SettingsSection } from "@/shell"
import { Button } from "@opencode-ai/ui/button"
import { usePluginsText } from "../i18n"
import { usePluginHost } from "../provider"
import { PluginRow } from "./plugin-row"
import "./plugins.css"

function PluginsSettings(): JSX.Element {
  const host = usePluginHost()
  const t = usePluginsText()
  return (
    <section class="plugins-settings" aria-labelledby="plugins-settings-title">
      <h2 id="plugins-settings-title" class="plugins-settings-title">
        {t("plugins.settings.title")}
      </h2>
      <p class="plugins-settings-description">{t("plugins.settings.description")}</p>
      <Show when={host.safeMode()}>
        <div role="status" class="plugins-settings-safe-mode">
          <span>{t("plugins.safeMode")}</span>
          <Button type="button" variant="secondary" size="small" onClick={() => host.leaveSafeMode()}>
            {t("plugins.safeMode.leave")}
          </Button>
        </div>
      </Show>
      <Show when={host.liveListError()}>
        {(reason) => <p role="alert">{t("plugins.list.failed", { reason: reason() })}</p>}
      </Show>
      <Show when={host.plugins().length > 0} fallback={<p>{t("plugins.settings.empty")}</p>}>
        <ul class="plugins-settings-list" aria-labelledby="plugins-settings-title">
          <For each={host.plugins()}>{(plugin) => <PluginRow plugin={plugin} />}</For>
        </ul>
      </Show>
    </section>
  )
}

export const pluginsSettingsSection: SettingsSection = {
  id: "plugins",
  title: () => useI18n().t("plugins.settings.title"),
  group: "app",
  order: 90,
  view: PluginsSettings,
}
