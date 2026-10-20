import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useElapsed } from "@/lib/delay"
import { mcpAppsDictionary } from "../i18n"

export function AppLoadingNotice(): JSX.Element {
  const t = useTranslator(mcpAppsDictionary)
  const shown = useElapsed()
  return (
    <Show when={shown()}>
      <p data-slot="mcp-app-loading" role="status">
        {t("mcpApps.loading")}
      </p>
    </Show>
  )
}
