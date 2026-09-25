import type { JSX } from "solid-js"
import type { PluginPlatform } from "@claxedo/plugin-api"
import { usePluginsText } from "../i18n"

export function PluginWarning(props: { readonly platform: PluginPlatform }): JSX.Element {
  const t = usePluginsText()
  return (
    <p role="note" class="plugin-warning">
      {t(props.platform === "desktop" ? "plugins.warning.desktop" : "plugins.warning.web")}
    </p>
  )
}
