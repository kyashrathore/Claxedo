import { createSignal, Show, type Accessor } from "solid-js"
import type { Account } from "@/server"
import { SettingsRow } from "@/settings"
import { Button, ClaxedoIconButton } from "@/ui"
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
  const [confirming, setConfirming] = createSignal(false)
  const busy = () => props.store.activity()?.key === props.account.id
  const description = () => {
    const health = keyCheckWords(t, props.account, props.store.liveChecks()[props.account.id])
    return [...(props.detail === undefined ? [] : [props.detail]), ...health].join(" · ")
  }
  return (
    <SettingsRow title={props.label} description={description()}>
      <Show when={!props.readOnly}>
        <Show
          when={confirming()}
          fallback={
            <>
              <ClaxedoIconButton icon="reload" size="small" variant="ghost" aria-label={t("settings.keys.check")} disabled={busy()} onClick={() => props.store.check(props.account.id)} />
              <Show when={props.store.remove}>
                <ClaxedoIconButton icon="trash" size="small" variant="ghost" aria-label={t("settings.keys.remove")} disabled={busy()} onClick={() => setConfirming(true)} />
              </Show>
            </>
          }
        >
          <span class="text-13-regular text-text-weak">{t("settings.keys.removeConfirm")}</span>
          <Button size="small" variant="contrast" disabled={busy()} onClick={() => props.store.remove?.(props.account.id)}>{t("settings.keys.remove")}</Button>
          <Button size="small" variant="ghost" disabled={busy()} onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
        </Show>
      </Show>
    </SettingsRow>
  )
}
