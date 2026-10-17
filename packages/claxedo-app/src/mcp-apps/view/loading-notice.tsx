import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { PLACEHOLDER_DELAY_MS, SLOW_LOAD_MS, useElapsed } from "@/lib/delay"
import { mcpAppsDictionary } from "../i18n"

export function AppLoadingNotice(): JSX.Element {
  const t = useTranslator(mcpAppsDictionary)
  const shown = useElapsed(PLACEHOLDER_DELAY_MS)
  const slow = useElapsed(SLOW_LOAD_MS)
  return (
    <Show when={shown()}>
      <p data-slot="mcp-app-loading" role="status">
        {slow() ? t("mcpApps.loadingSlow") : t("mcpApps.loading")}
      </p>
    </Show>
  )
}
