import { useTranslatedLazyView } from "@/i18n"
import { useDialog } from "@/ui"
import { loadSettingsTranslations } from "./translations"

const loadDrawer = () => import("./view/machine-connect").then((module) => module.ConnectMachineDrawer)

const translations = () => loadSettingsTranslations().then((dictionary) => [dictionary])

export function useConnectMachine(): () => void {
  const dialog = useDialog()
  const ConnectMachineDrawer = useTranslatedLazyView(loadDrawer, translations)
  return () => dialog.show(() => <ConnectMachineDrawer />)
}
