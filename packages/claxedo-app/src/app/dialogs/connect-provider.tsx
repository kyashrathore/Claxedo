// Claxedo stores provider credentials in the control plane, so this dialog connects API keys and OAuth through Claxedo-owned credential routes.
//
// The flow itself lives in `ProviderConnectForm`, which the onboarding setup
// page renders inline. This file is only the dialog shell around it: title,
// close, and the success toast.

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { useProviders } from "@/app/providers/use-providers"
import { ProviderConnectForm } from "./provider-connect-form"

export function DialogConnectProvider(props: { provider: string; harness?: string; onConnected?: () => void | Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const providers = useProviders(props.harness)
  const provider = createMemo(() => providers.all().get(props.provider)!)

  return (
    <Dialog title={language.t("provider.connect.title", { provider: provider().name })} transition>
      <ProviderConnectForm
        provider={props.provider}
        harness={props.harness}
        onConnected={props.onConnected}
        onDone={() => {
          dialog.close()
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("provider.connect.toast.connected.title", { provider: provider().name }),
            description: language.t("provider.connect.toast.connected.description", { provider: provider().name }),
          })
        }}
      />
    </Dialog>
  )
}
