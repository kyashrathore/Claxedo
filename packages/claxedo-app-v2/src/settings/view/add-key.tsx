import { createSignal, Show } from "solid-js"
import { TextInput } from "@/ui"
import { Button } from "@opencode-ai/ui/button"
import { useTranslator } from "@/i18n"
import type { Harness } from "../accounts"
import { dictionary } from "../i18n"

export function AddKeyForm(props: {
  readonly harness: Harness
  readonly busy: boolean
  readonly onSave: (label: string, secret: string) => Promise<void>
  readonly onCancel: () => void
}) {
  const t = useTranslator(dictionary)
  const [label, setLabel] = createSignal(props.harness.vendor)
  const [secret, setSecret] = createSignal("")
  const [failure, setFailure] = createSignal<string>()

  const submit = async (event: Event) => {
    event.preventDefault()
    if (!secret().trim() || props.busy) return
    setFailure(undefined)
    try {
      await props.onSave(label().trim() || props.harness.vendor, secret().trim())
      setSecret("")
      props.onCancel()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String((error as { message?: string }).message ?? error))
    }
  }

  return (
    <form class="settings-fields" aria-label={t("settings.accounts.addKey")} onSubmit={(event) => void submit(event)}>
      <span class="settings-row-description">{t("settings.accounts.keyHint", { harness: props.harness.label })}</span>
      <TextInput aria-label={t("settings.accounts.keyLabel")} placeholder={t("settings.accounts.keyLabel")} value={label()} onInput={(event) => setLabel(event.currentTarget.value)} />
      <TextInput type="password" autocomplete="off" aria-label={t("settings.accounts.keySecret")} placeholder={t("settings.accounts.keySecret")} value={secret()} onInput={(event) => setSecret(event.currentTarget.value)} />
      <Show when={failure()}>{(message) => <p class="settings-note" data-tone="danger" role="alert">{message()}</p>}</Show>
      <div class="settings-inline">
        <Button type="submit" size="small" variant="primary" disabled={props.busy || !secret().trim()}>{t("settings.accounts.keySave")}</Button>
        <Button type="button" size="small" variant="ghost" onClick={() => props.onCancel()}>{t("settings.common.cancel")}</Button>
      </div>
    </form>
  )
}
