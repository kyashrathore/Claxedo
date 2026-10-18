import { Show, type Component, type JSX } from "solid-js"
import { useAgeClock } from "@/lib/clock"
import { formatCompactAge, formatRelativeTime } from "@/lib/relative-time"
import { useI18n } from "@/i18n"
import { ClaxedoIconButton, Button, Tooltip } from "@/ui"
import type { AccountWords } from "../account-words"
import { useAccountsText, type AccountsText } from "../i18n"
import { ORG_ACCOUNT_KEY } from "../model"
import "./account-actions.css"

export function LabelHint(props: { readonly value: string; readonly children: JSX.Element }) {
  return (
    <Tooltip value={props.value} placement="top">
      <span class="flex items-center" onClick={(event) => event.preventDefault()}>
        {props.children}
      </span>
    </Tooltip>
  )
}

export const CheckedAge: Component<{ at: number; t: AccountsText; locale?: string; class?: string }> = (props) => {
  const now = useAgeClock(() => props.at)
  return (
    <span class={props.class} aria-label={props.t("common.lastChecked", { ago: formatRelativeTime(props.at, props.locale, now()) })}>
      {formatCompactAge(props.at, now()) ?? props.t("common.justNow")}
    </span>
  )
}

function AccountCheckButton(props: { readonly checking: boolean; readonly disabled: boolean; readonly checkedAt: number | undefined; readonly onCheck: () => void }) {
  const t = useAccountsText()
  const i18n = useI18n()
  const now = useAgeClock(() => props.checkedAt)
  const hint = () => {
    const at = props.checkedAt
    return at === undefined ? t("settings.providers.agents.checkNow") : t("settings.providers.agents.checkNowAgo", { ago: formatRelativeTime(at, i18n.intlTag(), now()) })
  }
  return (
    <Tooltip value={hint()} placement="top" class="flex">
      <ClaxedoIconButton
        icon="reload"
        size="small"
        variant="ghost"
        data-action="agent-account-check"
        aria-label={t("settings.providers.agents.checkNow")}
        aria-busy={props.checking ? "true" : undefined}
        disabled={props.checking || props.disabled}
        onClick={() => props.onCheck()}
      />
    </Tooltip>
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
    <Show when={props.account.ids.length > 0 || props.account.group === "machine"}>
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
