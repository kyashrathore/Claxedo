import { useTranslator } from "@/i18n"
import { useServer, type PluginSourceInput, type PluginSourceRecord } from "@/server"
import { requestConfirm, showToast, useDialog } from "@/ui"
import { errorMessage } from "./actions"
import { marketplaceDictionary } from "./i18n"

export function createSourceActions(input: {
  readonly refresh: () => Promise<void>
  readonly onRemoved: () => void
  readonly onAdded: () => void
}) {
  const server = useServer()
  const dialog = useDialog()
  const t = useTranslator(marketplaceDictionary)
  const remove = async (source: PluginSourceRecord) => {
    const confirmed = await requestConfirm(dialog, {
      title: t("marketplace.confirm.removeSourceTitle", { label: source.label }),
      body: t("marketplace.confirm.removeSourceBody"),
      confirmLabel: t("marketplace.confirm.remove"),
      cancelLabel: t("marketplace.cancel"),
    })
    if (!confirmed) return
    try {
      await server.marketplace.removeSource(source.id)
      input.onRemoved()
      await input.refresh()
    } catch (error) {
      showToast({ title: t("marketplace.toast.removeSourceFailed"), description: errorMessage(error) })
    }
  }
  const add = async (registration: PluginSourceInput) => {
    await server.marketplace.addSource(registration)
    input.onAdded()
    await input.refresh()
  }
  return { add, remove }
}
