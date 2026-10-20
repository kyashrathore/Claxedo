import { Show, type Accessor } from "solid-js"
import type { Account } from "@/server"
import { SettingsRow } from "@/settings"
import { ClaxedoIconButton, requestConfirm, useDialog } from "@/ui"
import { keyCheckWords } from "../account-words"
import { useAccountsText } from "../i18n"
import type { LiveCheck } from "../model"

export type KeyRowStore = {
  readonly activity: Accessor<{ readonly key: string } | undefined>
  readonly liveChecks: Accessor<Readonly<Record<string, LiveCheck>>>
  readonly check: (id: string) => void
  readonly remove?: (id: string) => void
}

export function KeyRow(props: { readonly account: Account; readonly label: string; readonly detail?: string; readonly store: KeyRowStore; readonly readOnly?: boolean }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const busy = () => props.store.activity()?.key === props.account.id
  const description = () => {
    const health = keyCheckWords(t, props.account, props.store.liveChecks()[props.account.id])
    return [...(props.detail === undefined ? [] : [props.detail]), ...health].join(" · ")
  }
  const remove = async (removeKey: (id: string) => void) => {
    const confirmed = await requestConfirm(dialog, { title: t("settings.keys.removeConfirm"), body: props.label, confirmLabel: t("settings.keys.remove"), cancelLabel: t("common.cancel"), destructive: true })
    if (confirmed) removeKey(props.account.id)
  }
  return (
    <SettingsRow title={props.label} description={description()}>
      <Show when={!props.readOnly}>
        <ClaxedoIconButton icon="reload" size="small" variant="ghost" aria-label={t("settings.keys.check")} disabled={busy()} onClick={() => props.store.check(props.account.id)} />
        <Show when={props.store.remove}>
          {(removeKey) => <ClaxedoIconButton icon="trash" size="small" variant="ghost" aria-label={t("settings.keys.remove")} disabled={busy()} onClick={() => void remove(removeKey())} />}
        </Show>
      </Show>
    </SettingsRow>
  )
}
