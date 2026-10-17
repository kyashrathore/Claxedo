import { Show, type JSX } from "solid-js"
import { ClaxedoIconButton, Button, Tooltip } from "@/ui"
import type { AccountWords } from "../account-words"
import { useAccountsText } from "../i18n"
import { ORG_ACCOUNT_KEY, type AccountReach } from "../model"
import { AccountCheckButton } from "./account-check"
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
  readonly checking: boolean
  readonly removing: boolean
  readonly onReconnect: (credentialId: string) => void
  readonly onCheck: () => void
  readonly onRemove: () => void
}

export function AccountActions(props: AccountActionsProps) {
  const t = useAccountsText()
  return (
    <Show when={props.account.ids.length > 0 || props.account.machine}>
      <span class="flex min-w-11 flex-wrap items-center justify-end gap-1">
        <Show when={props.account.key !== ORG_ACCOUNT_KEY && props.account.refused && props.account.ids[0]}>
          {(credentialId) => (
            <Button class="min-h-8" size="small" variant="neutral" data-action="agent-reconnect" onClick={() => props.onReconnect(credentialId())}>
              {t("settings.providers.agents.reconnectAccount")}
            </Button>
          )}
        </Show>
        <AccountCheckButton checking={props.checking} disabled={props.removing} checkedAt={props.account.checkedAt} onCheck={props.onCheck} />
        <Show when={props.account.ids.length > 0}>
          <ClaxedoIconButton
            icon="trash"
            size="small"
            variant="ghost"
            data-action="agent-account-remove"
            aria-label={t("settings.providers.agents.removeAccount")}
            disabled={props.removing}
            onClick={() => props.onRemove()}
          />
        </Show>
      </span>
    </Show>
  )
}
