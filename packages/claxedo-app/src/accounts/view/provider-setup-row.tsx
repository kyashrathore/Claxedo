import { createSignal, Show, type JSX } from "solid-js"
import { connectContextFor } from "@/lib/harness-catalog"
import { useDialog, Button, ProviderIcon } from "@/ui"
import { useAccountsText } from "../i18n"
import { DialogProviderConnect } from "./connect-dialog"

export function ProviderSetupRow(props: { readonly id: string; readonly name: string; readonly harness: string; readonly note: string | undefined; readonly onConnected: () => Promise<void>; readonly children?: JSX.Element }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const [connecting, setConnecting] = createSignal(false)
  const openConnect = () => {
    setConnecting(true)
    const context = connectContextFor({ providerId: props.id, engine: props.harness, vendor: props.name })
    void dialog.show(() => <DialogProviderConnect provider={props.id} context={context} harness={props.harness} onConnected={props.onConnected} />, () => setConnecting(false))
  }
  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={props.id}>
      <div class="flex w-full flex-wrap items-start justify-between gap-4 py-3">
        <button type="button" class="flex min-w-0 flex-1 items-start gap-3 border-none bg-transparent p-0 text-left" onClick={() => openConnect()}>
          <ProviderIcon id={props.id} class="size-5 shrink-0 icon-strong-base" />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-14-medium text-text-strong">{props.name}</span>
            <Show when={props.note}>{(note) => <span class="text-12-regular text-text-weak">{note()}</span>}</Show>
          </div>
        </button>
        <div class="flex shrink-0 items-center gap-2">
          <Show when={connecting()} fallback={<Button size="large" variant="ghost" onClick={() => openConnect()}>{t("common.connect")}</Button>}>
            <span class="text-12-regular text-text-interactive-base">{t("settings.providers.connect.open")}</span>
          </Show>
        </div>
      </div>
      {props.children}
    </div>
  )
}
