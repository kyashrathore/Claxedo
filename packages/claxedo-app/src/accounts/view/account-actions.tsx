import { Show, type JSX } from "solid-js"
import { ClaxedoIconButton, Button, Tooltip } from "@/ui"
import type { AccountWords } from "../account-words"
import { useAccountsText } from "../i18n"
import { ORG_ACCOUNT_KEY, type AccountReach } from "../model"
import { ACCOUNT_REACH_KEYS } from "./account-status"

export function LabelHint(props: { readonly value: string; readonly children: JSX.Element }) {
  return (
    <Tooltip value={props.value} placement="top">
      <span class="flex items-center" onClick={(event) => event.preventDefault()}>
        {props.children}
      </span>
    </Tooltip>
  )
}

export function Reach(props: { readonly reach: AccountReach; readonly source?: string }) {
  const t = useAccountsText()
  return (
    <LabelHint value={t(ACCOUNT_REACH_KEYS[props.reach].note)}>
      <span class="text-12-regular text-text-weak" data-reach={props.reach}>
        {[props.source, t(ACCOUNT_REACH_KEYS[props.reach].label)].filter(Boolean).join(" · ")}
      </span>
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
      <Show when={props.account.key !== ORG_ACCOUNT_KEY && props.account.refused && props.account.ids[0]}>
        {(credentialId) => (
          <Button size="small" variant="neutral" data-action="agent-reconnect" onClick={() => props.onReconnect(credentialId())}>
            {t("settings.providers.agents.reconnectAccount")}
          </Button>
        )}
      </Show>
      <Show when={props.account.key !== ORG_ACCOUNT_KEY}>
        <ClaxedoIconButton
          icon="reload"
          size="small"
          variant="ghost"
          data-action="agent-account-check"
          aria-label={t("settings.providers.agents.checkAccount")}
          disabled={props.checking || props.removing !== undefined}
          onClick={() => props.onCheck()}
        />
      </Show>
      <Show when={props.account.ids.length > 0}>
        <ClaxedoIconButton
          icon="trash"
          size="small"
          variant="ghost"
          data-action="agent-account-remove"
          aria-label={t("settings.providers.agents.removeAccount")}
          disabled={props.removing !== undefined}
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
        {props.removing !== undefined && props.account.ids.includes(props.removing) ? t("settings.providers.agents.removingAccount") : t("settings.providers.agents.removeAccount")}
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
      <span class="flex min-w-11 flex-wrap items-center justify-end gap-1">
        <Show when={props.confirming} fallback={<RestingActions {...props} />}>
          <ConfirmRemove {...props} />
        </Show>
      </span>
    </Show>
  )
}
