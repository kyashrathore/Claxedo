// Claxedo routes provider selection to Claxedo-owned connect/custom dialogs instead of upstream global-sync store dialogs.
//
// The catalog itself lives in `ProviderList`, shared with the onboarding setup
// page. This file is the dialog shell and the selection routing.
import { type Component } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DialogConnectProvider } from "@/app/dialogs/connect-provider"
import { useLanguage } from "@/platform/i18n/provider"
import { DialogCustomProvider } from "@/app/dialogs/custom-provider"
import { CUSTOM_PROVIDER_ID, ProviderList } from "./provider-list"

export const DialogSelectProvider: Component<{ harness?: string }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog title={language.t("command.provider.connect")} transition>
      <ProviderList
        harness={props.harness}
        onSelect={(providerId) => {
          if (providerId === CUSTOM_PROVIDER_ID) {
            dialog.show(() => <DialogCustomProvider back="providers" />)
            return
          }
          dialog.show(() => <DialogConnectProvider provider={providerId} harness={props.harness} />)
        }}
      />
    </Dialog>
  )
}
