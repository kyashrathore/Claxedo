import type { JSX } from "solid-js"
import { usePluginsText } from "../i18n"

export function PluginWarning(): JSX.Element {
  const t = usePluginsText()
  return (
    <p role="note" class="plugin-warning">
      {t("plugins.warning")}
    </p>
  )
}
