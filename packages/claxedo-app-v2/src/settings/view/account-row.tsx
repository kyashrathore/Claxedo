import { createSignal, Show } from "solid-js"
import { Icon, IconButton, RadioItem, Tooltip } from "@/ui"
import { Button } from "@opencode-ai/ui/button"
import { useTranslator } from "@/i18n"
import { formatCompactAge } from "@/lib/relative-time"
import { dictionary } from "../i18n"
import type { AccountActivity } from "../store"
import type { AccountWords } from "./account-words"

export function AccountRow(props: {
  readonly account: AccountWords
  readonly activity: AccountActivity | undefined
  readonly onCheck: () => void
  readonly onRemove: () => void
}) {
  const t = useTranslator(dictionary)
  const [confirming, setConfirming] = createSignal(false)
  const busy = (kind: AccountActivity["kind"]) => props.activity?.kind === kind && props.activity.key === props.account.key
  const age = () => (props.account.checkedAt === undefined ? undefined : (formatCompactAge(props.account.checkedAt) ?? t("settings.common.justNow")))

  return (
    <div class="settings-account" data-component="agent-account" data-account={props.account.key} data-refused={props.account.refused ? "" : undefined}>
      <RadioItem value={props.account.key} disabled={props.account.disabled} label={props.account.label} description={props.account.detail} />
      <Show when={props.account.note}>
        {(note) => (
          <Tooltip value={note()} placement="top">
            <Icon name="help" size="small" role="img" aria-label={note()} />
          </Tooltip>
        )}
      </Show>
      <Show when={props.account.alert}>
        {(alert) => <Icon name="circle-alert" size="small" role="img" aria-label={alert()} data-component="agent-account-alert" />}
      </Show>
      <Show when={props.account.reach === "local-and-cloud"}>
        <Tooltip value={t("settings.accounts.reachLocalCloudNote")} placement="top">
          <Icon name="cloud" size="small" role="img" aria-label={t("settings.accounts.reachCloud")} />
        </Tooltip>
      </Show>
      <Show when={age()}>{(value) => <span class="settings-row-description" data-component="agent-account-checked">{value()}</span>}</Show>
      <div class="settings-account-actions">
        <Show when={confirming()} fallback={<RowActions account={props.account} busy={busy} onCheck={props.onCheck} onConfirm={() => setConfirming(true)} />}>
          <span class="settings-row-description">{t("settings.accounts.removeAccountConfirm")}</span>
          <Button size="small" variant="primary" disabled={props.activity !== undefined} onClick={() => props.onRemove()}>
            {busy("removing") ? t("settings.accounts.removingAccount") : t("settings.accounts.removeAccount")}
          </Button>
          <Button size="small" variant="ghost" disabled={props.activity !== undefined} onClick={() => setConfirming(false)}>
            {t("settings.common.cancel")}
          </Button>
        </Show>
      </div>
    </div>
  )
}

function RowActions(props: {
  readonly account: AccountWords
  readonly busy: (kind: AccountActivity["kind"]) => boolean
  readonly onCheck: () => void
  readonly onConfirm: () => void
}) {
  const t = useTranslator(dictionary)
  return (
    <>
      <IconButton icon="reload" size="small" variant="ghost" aria-label={t("settings.accounts.checkNamed", { account: props.account.label })} disabled={props.busy("checking")} onClick={() => props.onCheck()} />
      <Show when={!props.account.machine}>
        <IconButton icon="trash" size="small" variant="ghost" aria-label={t("settings.accounts.removeNamed", { account: props.account.label })} onClick={() => props.onConfirm()} />
      </Show>
    </>
  )
}
