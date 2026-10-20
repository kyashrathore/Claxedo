import { createSignal } from "solid-js"
import { useErrorCopy, useTranslator, type DomainTranslate } from "@/i18n"
import { toAppError, useServer, type AppPluginsApi } from "@/server"
import { requestConfirm, showToast, useDialog } from "@/ui"
import { marketplaceDictionary, type MarketplaceKey } from "../i18n"
import { useConsentDrawer } from "./consent-drawer"
import { appPluginUpdate, type AppPluginEntry } from "./model"

type Translate = DomainTranslate<MarketplaceKey>

function confirmUninstall(dialog: ReturnType<typeof useDialog>, t: Translate, entry: AppPluginEntry) {
  return requestConfirm(dialog, {
    title: t("marketplace.app.confirm.uninstallTitle", { name: entry.name }),
    body: t("marketplace.app.confirm.uninstallBody", { name: entry.name }),
    confirmLabel: t("marketplace.app.confirm.uninstall"),
    cancelLabel: t("marketplace.cancel"),
    destructive: true,
  })
}

function confirmOrganizationOff(dialog: ReturnType<typeof useDialog>, t: Translate, entry: AppPluginEntry) {
  return requestConfirm(dialog, {
    title: t("marketplace.app.confirm.organizationOffTitle", { name: entry.name }),
    body: t("marketplace.app.confirm.organizationOffBody"),
    confirmLabel: t("marketplace.app.confirm.turnOff"),
    cancelLabel: t("marketplace.cancel"),
    destructive: false,
  })
}

function createPending(t: Translate) {
  const errorCopy = useErrorCopy("marketplace")
  const [pending, setPending] = createSignal<string>()
  const run = async (entry: AppPluginEntry, work: () => Promise<void>) => {
    setPending(entry.id)
    try {
      await work()
    } catch (error) {
      showToast({ title: t("marketplace.app.toast.failed", { name: entry.name }), description: errorCopy(toAppError(error)).message })
    } finally {
      setPending(undefined)
    }
  }
  return { pending, run }
}

function signedApi(api: AppPluginsApi | undefined): AppPluginsApi {
  if (!api) throw new Error("App plugins need a signed account")
  return api
}

export function createAppPluginActions() {
  const server = useServer()
  const dialog = useDialog()
  const t = useTranslator(marketplaceDictionary)
  const consent = useConsentDrawer()
  const { pending, run } = createPending(t)
  const api = () => signedApi(server.appPlugins)
  return {
    pending,
    install: (entry: AppPluginEntry) => consent(entry, "install", (version) => api().install(entry.id, version)),
    turnOn: (entry: AppPluginEntry) => consent(entry, "turnOn", () => api().setEnabled(entry.id, true)),
    turnOff: (entry: AppPluginEntry) => run(entry, () => api().setEnabled(entry.id, false)),
    update: (entry: AppPluginEntry) => {
      const version = appPluginUpdate(entry)
      return version ? run(entry, () => api().update(entry.id, version)) : Promise.resolve()
    },
    setActiveForOrganization: async (entry: AppPluginEntry, active: boolean) => {
      if (!active && !(await confirmOrganizationOff(dialog, t, entry))) return
      await run(entry, () => api().setActiveForOrganization(entry.id, active))
    },
    setOrganizationDefault: (entry: AppPluginEntry, enabled: boolean) => run(entry, () => api().setOrganizationDefault(entry.id, enabled)),
    uninstall: async (entry: AppPluginEntry) => {
      if (!(await confirmUninstall(dialog, t, entry))) return
      await run(entry, () => api().uninstall(entry.id))
    },
  }
}

export type AppPluginActions = ReturnType<typeof createAppPluginActions>
