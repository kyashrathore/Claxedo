import type { PluginPlatform } from "@claxedo/plugin-api"
import type { useDialog } from "@/ui"
import type { PluginHost } from "../host"
import type { PluginsText } from "../i18n"
import type { PluginSummary } from "../model"
import { confirmThrough } from "./confirm-dialog"

export type LiveConfirmation = {
  readonly host: PluginHost
  readonly dialog: ReturnType<typeof useDialog>
  readonly platform: PluginPlatform
  readonly t: PluginsText
}

export async function confirmLivePlugin(input: LiveConfirmation, plugin: PluginSummary): Promise<void> {
  const { t } = input
  const confirmed = await confirmThrough(input.dialog, {
    title: t("plugins.add.title", { name: plugin.name }),
    description: t(input.platform === "desktop" ? "plugins.add.desktop" : "plugins.add.web", { name: plugin.name }),
    confirmLabel: t("plugins.add.accept"),
  })
  if (!confirmed) return
  input.host.confirm(plugin.id)
  input.host.switchOn(plugin.id)
}
