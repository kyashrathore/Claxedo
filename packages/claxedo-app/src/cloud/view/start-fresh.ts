import { useServer, type PlacementId } from "@/server"
import { requestConfirm, useDialog } from "@/ui"
import { useCloudText } from "../i18n"

export type StartFreshAction = { readonly label: string; readonly run: () => void }

export type StartFreshConfirm = { readonly label: string; readonly confirm: (name: string) => Promise<boolean> }

export type StartFresh = { readonly label: string; readonly run: (id: PlacementId, name: string) => void }

export function useStartFreshConfirm(): StartFreshConfirm {
  const t = useCloudText()
  const dialog = useDialog()
  return {
    label: t("cloud.startFresh"),
    confirm: (name) => requestConfirm(dialog, {
      title: t("cloud.startFresh.title", { name }),
      body: t("cloud.startFresh.body"),
      confirmLabel: t("cloud.startFresh"),
      cancelLabel: t("cloud.startFresh.cancel"),
      destructive: true,
    }),
  }
}

export function useStartFresh(): StartFresh {
  const server = useServer()
  const { label, confirm } = useStartFreshConfirm()
  const startFresh = async (id: PlacementId, name: string) => {
    if (!(await confirm(name))) return
    await server.cloud.startFresh(id)
  }
  return {
    label,
    run: (id, name) => void startFresh(id, name).catch((error: unknown) => console.warn("The workspace could not be started fresh", { placementId: id, error })),
  }
}
