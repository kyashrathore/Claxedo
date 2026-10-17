import { createSignal, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { toAppError, useServer, type PluginCandidate, type PluginHarness } from "@/server"
import { FormDrawer, showToast, useDialog } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { pluginLabel } from "../model"
import { InstallHarnesses, InstallPlacement, harnessRows } from "./install-sections"

function createInstall(props: { readonly plugin: PluginCandidate; readonly revision: number; readonly done: () => void }) {
  const t = useTranslator(marketplaceDictionary)
  const server = useServer()
  const errorCopy = useErrorCopy("marketplace")
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const install = async (harnessIds: readonly PluginHarness[]) => {
    if (harnessIds.length === 0) {
      setError(t("marketplace.install.noHarness"))
      return
    }
    setError(undefined)
    setBusy(true)
    try {
      const change = await server.marketplace.setActivation({ pluginInstanceId: props.plugin.pluginInstanceId, harnessIds, choice: true, revision: props.revision })
      if (change.reconciliation.state === "failed") {
        showToast({
          title: t("marketplace.install.syncPending", { name: pluginLabel(props.plugin) }),
          description: change.reconciliation.message ?? t("marketplace.install.syncLater"),
        })
      }
      props.done()
    } catch (cause) {
      setError(errorCopy(toAppError(cause)).message)
    } finally {
      setBusy(false)
    }
  }
  return { error, busy, install }
}

function DrawerInstallPlugin(props: { readonly plugin: PluginCandidate; readonly revision: number; readonly supportedHarnesses: readonly PluginHarness[] }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const dialog = useDialog()
  const rows = () => harnessRows(props.plugin, props.supportedHarnesses)
  const [selected, setSelected] = createSignal(new Set(rows().filter((row) => row.available).map((row) => row.harnessId)))
  const install = createInstall({ plugin: props.plugin, revision: props.revision, done: () => dialog.close() })
  return (
    <FormDrawer
      title={t("marketplace.install.title", { name: pluginLabel(props.plugin) })}
      submitLabel={t("marketplace.install.add")}
      busyLabel={t("marketplace.install.adding")}
      cancelLabel={t("marketplace.cancel")}
      busy={install.busy()}
      error={install.error()}
      onSubmit={() => void install.install([...selected()])}
      onCancel={() => dialog.close()}
    >
      <InstallPlacement plugin={props.plugin} />
      <InstallHarnesses rows={rows()} selected={selected()} onChange={setSelected} />
    </FormDrawer>
  )
}

export function useInstallDrawer() {
  const dialog = useDialog()
  return (plugin: PluginCandidate, revision: number, supportedHarnesses: readonly PluginHarness[]) =>
    new Promise<void>((resolve) => {
      void dialog.show(() => <DrawerInstallPlugin plugin={plugin} revision={revision} supportedHarnesses={supportedHarnesses} />, resolve)
    })
}
