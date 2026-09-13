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
import { connectContextFor, connectVars } from "@/platform/identity/harness-catalog"

export function DialogConnectProvider(props: { provider: string; harness: string; scope?: string; onConnected?: () => void | Promise<void> }) {
  const dialog = useDialog()
  const language = useLanguage()
  const providers = useProviders(() => props.harness, () => props.scope)
  // The catalog holds model providers, and the id may be a harness's own login
  // provider it has never heard of; the connect context names that harness from
  // its own record, so the catalog name is only the vendor for the other case.
  const vendor = createMemo(() => providers.all().get(props.provider)?.name ?? props.provider)

  const context = createMemo(() =>
    connectContextFor({ providerId: props.provider, engine: props.harness, vendor: vendor() }))

  return (
    <Dialog title={language.t(`provider.connect.title.${context().kind}`, connectVars(context()))} transition>
      <ProviderConnectForm
        provider={props.provider}
        context={context()}
        harness={props.harness}
        workspaceScope={props.scope}
        onConnected={props.onConnected}
        onDone={() => {
          dialog.close()
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("provider.connect.toast.connected.title", { vendor: context().vendor }),
            description: language.t(`provider.connect.toast.connected.description.${context().kind}`, connectVars(context())),
          })
        }}
      />
    </Dialog>
  )
}
