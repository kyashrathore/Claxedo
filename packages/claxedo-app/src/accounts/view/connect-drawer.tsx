import { connectSubject, connectVars } from "@/lib/harness-catalog"
import { FormDrawer, useDialog } from "@/ui"
import { CONTEXT_COPY, createProviderConnect, type ConnectFormInput } from "../connect-form"
import { connectSubmit } from "../connect-submit"
import { useAccountsText } from "../i18n"
import { ProviderConnectFields } from "./connect-form"

export function DrawerProviderConnect(props: ConnectFormInput) {
  const t = useAccountsText()
  const dialog = useDialog()
  const input: ConnectFormInput = {
    ...props,
    onConnected: async () => {
      await props.onConnected?.()
      dialog.close()
    },
  }
  const form = createProviderConnect(input)
  const submit = () => connectSubmit(form)
  const subject = () => connectSubject(props.context)
  const title = () => (props.credentialId ? t("settings.providers.connect.reconnectTitle", { provider: subject() }) : t(CONTEXT_COPY.title[props.context.kind], connectVars(props.context)))
  const description = () => {
    if (props.credentialId) return t("settings.providers.connect.reconnectSubtitle")
    return form.store.audience === "org" ? t("settings.providers.connect.orgSubtitle") : t("settings.providers.connect.subtitle", { provider: subject() })
  }
  return (
    <FormDrawer
      title={title()}
      description={description()}
      submitLabel={t(submit().label)}
      busyLabel={t(submit().busyLabel)}
      cancelLabel={t("common.cancel")}
      busy={submit().busy}
      canSubmit={submit().enabled}
      error={form.store.state === "error" ? form.store.error : undefined}
      onSubmit={() => submit().run()}
      onCancel={() => dialog.close()}
    >
      <ProviderConnectFields form={form} input={props} />
    </FormDrawer>
  )
}
