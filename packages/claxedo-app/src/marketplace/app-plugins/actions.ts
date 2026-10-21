import { useTranslator, type DomainTranslate } from "@/i18n"
import { useServer, type AppPluginsApi, type MarketplaceCatalog } from "@/server"
import { requestConfirm, useDialog } from "@/ui"
import { marketplaceDictionary, type MarketplaceKey } from "../i18n"
import { createPendingWrite } from "../pending-write"
import { withCurrentRevision } from "../revision"
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

function signedApi(api: AppPluginsApi | undefined): AppPluginsApi {
  if (!api) throw new Error("App plugins need a signed account")
  return api
}

export function createAppPluginActions(activation: {
  readonly catalog: () => MarketplaceCatalog | undefined
  readonly reread: () => Promise<void>
}) {
  const server = useServer()
  const dialog = useDialog()
  const t = useTranslator(marketplaceDictionary)
  const consent = useConsentDrawer()
  const write = createPendingWrite()
  const run = (entry: AppPluginEntry, work: () => Promise<void>) => write.run(entry.id, t("marketplace.app.toast.failed", { name: entry.name }), work)
  const api = () => signedApi(server.appPlugins)
  return {
    pending: write.pending,
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
    setTools: (entry: AppPluginEntry, on: boolean) =>
      write.run(entry.id, t(on ? "marketplace.app.toast.toolsOnFailed" : "marketplace.app.toast.toolsOffFailed", { name: entry.name }), () =>
        withCurrentRevision({
          revision: () => activation.catalog()?.revision,
          reread: activation.reread,
          run: (revision) => api().setTools({ pluginId: entry.id, on, revision, harnessIds: activation.catalog()?.supportedHarnesses ?? [] }),
        }),
      ),
    uninstall: async (entry: AppPluginEntry) => {
      if (!(await confirmUninstall(dialog, t, entry))) return
      await run(entry, () => api().uninstall(entry.id))
    },
  }
}

export type AppPluginActions = ReturnType<typeof createAppPluginActions>
