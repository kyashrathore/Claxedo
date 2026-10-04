import { connectSubject, connectVars } from "@/lib/harness-catalog"
import { useServer } from "@/server"
import { ClaxedoIconButton as IconButton, useDialog, Dialog, DialogBody } from "@/ui"
import { CONTEXT_COPY, type ConnectFormInput } from "../connect-form"
import { useAccountsText } from "../i18n"
import { ProviderConnectForm } from "./connect-form"

function ConnectCard(props: ConnectFormInput & { readonly onClose: () => void }) {
  const t = useAccountsText()
  const server = useServer()
  const subject = () => connectSubject(props.context)
  const title = () =>
    props.credentialId ? t("settings.providers.connect.reconnectTitle", { provider: subject() }) : t(CONTEXT_COPY.title[props.context.kind], connectVars(props.context))
  const stored = () => (server.capabilities()?.thisMachine ? "settings.providers.connect.subtitle" : "settings.providers.connect.subtitleHosted")
  const subtitle = () => (props.credentialId ? t("settings.providers.connect.reconnectSubtitle") : t(stored(), { provider: subject() }))
  return (
    <div class="flex min-h-0 flex-col" data-credential={props.credentialId}>
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-border-weak-base py-3 pl-4 pr-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-14-medium text-text-strong">{title()}</span>
          <span class="text-12-regular text-text-weak">{subtitle()}</span>
        </div>
        <IconButton icon="close" variant="ghost" aria-label={t("common.close")} data-action="provider-connect-close" onClick={() => props.onClose()} />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-4" ref={(element) => requestAnimationFrame(() => (element.scrollTop = 0))}>
        <ProviderConnectForm {...props} />
      </div>
    </div>
  )
}

export function DialogProviderConnect(props: ConnectFormInput) {
  const dialog = useDialog()
  return (
    <Dialog fit class="claxedo-modal-backdrop" aria-label={props.context.vendor}>
      <DialogBody class="flex max-h-[80vh] min-h-0 flex-col">
        <ConnectCard
          {...props}
          onConnected={async () => {
            await props.onConnected?.()
            dialog.close()
          }}
          onClose={() => dialog.close()}
        />
      </DialogBody>
    </Dialog>
  )
}
