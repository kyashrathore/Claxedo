import type { ProviderConnect } from "./connect-form"
import type { AccountsKey } from "./i18n"

export type ConnectSubmit = {
  readonly label: AccountsKey
  readonly busyLabel: AccountsKey
  readonly busy: boolean
  readonly enabled: boolean
  readonly run: () => void
}

type SubmitSource = Pick<ProviderConnect, "store" | "selected" | "loadingMethods" | "methodsError" | "pastes" | "replaces" | "saveKey" | "startOAuth" | "finishOAuth">

const UNAVAILABLE: ConnectSubmit = { label: "common.continue", busyLabel: "common.saving", busy: false, enabled: false, run: () => undefined }

export function connectSubmit(form: SubmitSource): ConnectSubmit {
  const option = form.selected()
  const { store } = form
  if (option === undefined || form.loadingMethods() || form.methodsError() !== undefined) return UNAVAILABLE
  if (form.pastes()) {
    return { label: form.replaces() ? "provider.connect.replace" : "common.continue", busyLabel: "common.saving", busy: store.saving, enabled: true, run: () => void form.saveKey() }
  }
  if (store.state === "code" && store.authorization) {
    return { label: "common.continue", busyLabel: "common.saving", busy: store.saving, enabled: true, run: () => void form.finishOAuth(store.code.trim()) }
  }
  if (store.state === "pending" || store.state === "auto") {
    const busyLabel = store.state === "auto" ? "provider.connect.status.waiting" : "provider.connect.status.inProgress"
    return { label: "provider.connect.oauth.start", busyLabel, busy: true, enabled: true, run: () => undefined }
  }
  return { label: "provider.connect.oauth.start", busyLabel: "provider.connect.status.inProgress", busy: false, enabled: true, run: () => void form.startOAuth(option.index) }
}
