import { Show, type JSX } from "solid-js"
import { ClaxedoIconButton, Button, Tooltip } from "@/ui"
import type { AccountWords } from "../account-words"
import { useAccountsText } from "../i18n"
import type { AccountReach } from "../model"
import { ACCOUNT_REACH_KEYS, AccountReachMarks } from "./account-status"

export function LabelHint(props: { readonly value: string; readonly children: JSX.Element }) {
  return (
    <Tooltip value={props.value} placement="top">
      <span class="flex items-center" onClick={(event) => event.preventDefault()}>
        {props.children}
      </span>
    </Tooltip>
  )
}

export function Reach(props: { readonly reach: AccountReach }) {
  const t = useAccountsText()
  return (
    <LabelHint value={t(ACCOUNT_REACH_KEYS[props.reach].note)}>
      <AccountReachMarks reach={props.reach} t={t} class="flex items-center gap-1" iconClass="icon-weak-base" />
    </LabelHint>
  )
}

export type AccountActionsProps = {
  readonly account: AccountWords
  readonly confirming: boolean
  readonly checking: boolean
  readonly removing: string | undefined
  readonly onReconnect: (credentialId: string) => void
  readonly onCheck: () => void
  readonly onConfirm: (confirming: boolean) => void
  readonly onRemove: () => void
}

function RestingActions(props: AccountActionsProps) {
  const t = useAccountsText()
  return (
    <>
      <Show when={props.account.refused && props.account.ids[0]}>
        {(credentialId) => (
          <Button size="small" variant="neutral" data-action="agent-reconnect" onClick={() => props.onReconnect(credentialId())}>
            {t("settings.providers.agents.reconnectAccount")}
          </Button>
        )}
      </Show>
      <ClaxedoIconButton
        icon="reload"
        size="small"
        variant="ghost"
        data-action="agent-account-check"
        aria-label={t("settings.providers.agents.checkAccount")}
        disabled={props.checking}
        onClick={() => props.onCheck()}
      />
      <Show when={props.account.ids.length > 0}>
        <ClaxedoIconButton
          icon="trash"
          size="small"
          variant="ghost"
          data-action="agent-account-remove"
          aria-label={t("settings.providers.agents.removeAccount")}
          onClick={() => props.onConfirm(true)}
        />
      </Show>
    </>
  )
}

function ConfirmRemove(props: AccountActionsProps) {
  const t = useAccountsText()
  return (
    <>
      <span class="text-13-regular text-text-weak">{t("settings.providers.agents.removeAccountConfirm")}</span>
      <Button size="small" variant="contrast" disabled={props.removing !== undefined} data-action="agent-account-remove-confirm" onClick={() => props.onRemove()}>
        {props.removing === props.account.key ? t("settings.providers.agents.removingAccount") : t("settings.providers.agents.removeAccount")}
      </Button>
      <Button size="small" variant="ghost" disabled={props.removing !== undefined} data-action="agent-account-remove-cancel" onClick={() => props.onConfirm(false)}>
        {t("common.cancel")}
      </Button>
    </>
  )
}

export function AccountActions(props: AccountActionsProps) {
  return (
    <Show when={props.account.ids.length > 0 || props.account.machine}>
      <span
        class="flex shrink-0 min-w-11 items-center justify-end gap-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        classList={{ "opacity-0": !props.confirming }}
      >
        <Show when={props.confirming} fallback={<RestingActions {...props} />}>
          <ConfirmRemove {...props} />
        </Show>
      </span>
    </Show>
  )
}
