import { createSignal, Show } from "solid-js"
import type { Account } from "@/server"
import { SettingsRow } from "@/settings"
import { Button, ClaxedoIconButton } from "@/ui"
import { VERDICT_KEY } from "../account-words"
import { useAccountsText } from "../i18n"
import { isVerdict } from "../model"
import type { SandboxKeysStore } from "../sandbox-store"

export function SandboxKeyRow(props: { readonly account: Account; readonly label: string; readonly store: SandboxKeysStore }) {
  const t = useAccountsText()
  const [confirming, setConfirming] = createSignal(false)
  const busy = () => props.store.activity()?.key === props.account.id
  const description = () => {
    const live = props.store.liveChecks()[props.account.id]
    const stored = props.account.health !== undefined && isVerdict(props.account.health) ? props.account.health : undefined
    const verdict = live?.verdict ?? stored
    if (verdict === undefined) return t("settings.sandbox.notChecked")
    return [t(VERDICT_KEY[verdict]), ...(live?.reason === undefined ? [] : [live.reason])].join(" · ")
  }
  return (
    <SettingsRow title={props.label} description={description()}>
      <Show
        when={confirming()}
        fallback={
          <>
            <ClaxedoIconButton icon="reload" size="small" variant="ghost" aria-label={t("settings.sandbox.check")} disabled={busy()} onClick={() => props.store.check(props.account.id)} />
            <ClaxedoIconButton icon="trash" size="small" variant="ghost" aria-label={t("settings.sandbox.remove")} disabled={busy()} onClick={() => setConfirming(true)} />
          </>
        }
      >
        <span class="text-13-regular text-text-weak">{t("settings.sandbox.removeConfirm")}</span>
        <Button size="small" variant="contrast" disabled={busy()} onClick={() => props.store.remove(props.account.id)}>{t("settings.sandbox.remove")}</Button>
        <Button size="small" variant="ghost" disabled={busy()} onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
      </Show>
    </SettingsRow>
  )
}
