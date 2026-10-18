import { Show } from "solid-js"
import { useI18n } from "@/i18n"
import { ClaxedoIcon, RadioItem, requestConfirm, Switch, useDialog } from "@/ui"
import type { AccountWords, CloudConsent } from "../account-words"
import { useAccountsText } from "../i18n"
import { machineCheckKey, ORG_ACCOUNT_KEY, servedByList } from "../model"
import type { Accounts } from "../store"
import { AccountActions, CheckedAge, LabelHint } from "./account-actions"
import type { HarnessRowProps } from "./harness-row"

function AccountTitle(props: { readonly account: AccountWords }) {
  return (
    <span class="flex flex-wrap items-center gap-1.5">
      <span class="text-14-medium text-text-strong">{props.account.label}</span>
      <Show when={props.account.note}>
        {(note) => (
          <LabelHint value={note()}>
            <ClaxedoIcon name="help" size="small" class="icon-weak-base" role="img" aria-hidden="false" aria-label={note()} />
          </LabelHint>
        )}
      </Show>
      <Show when={props.account.alert}>
        {(alert) => <ClaxedoIcon name="circle-alert" size="small" class="icon-warning-base" role="img" aria-hidden="false" aria-label={alert()} />}
      </Show>
    </span>
  )
}

function AccountLines(props: { readonly account: AccountWords }) {
  return (
    <span class="flex flex-col gap-1 pt-0.5">
      <span class="text-13-regular leading-5 text-text-base">
        {props.account.kind}
        <Show when={props.account.detail}>{(detail) => <> · <span>{detail()}</span></>}</Show>
      </span>
      <Show when={props.account.where}>{(text) => <span class="text-12-regular leading-4 text-text-weak">{text()}</span>}</Show>
    </span>
  )
}

function CloudConsentSwitch(props: { readonly account: AccountWords; readonly consent: CloudConsent; readonly accounts: Accounts }) {
  const t = useAccountsText()
  const error = () => props.accounts.scopeErrors()[props.account.key]
  return (
    <div class="ml-6 flex flex-col gap-1 rounded-md border border-[var(--v2-border-border-muted)] bg-[var(--v2-background-bg-layer-02)] px-3 py-2 text-12-regular leading-4 text-text-weak">
      <Show when={props.consent.deliverable} fallback={<span>{t("settings.providers.cloudConsent.unavailable")}</span>}>
        <div class="flex items-center justify-between gap-3">
          <span class="flex min-w-0 flex-col gap-0.5">
            <span class="text-13-regular leading-5 text-text-base" aria-hidden="true">{t("settings.providers.cloudConsent.allow")}</span>
            <span>{t(props.consent.partial ? "settings.providers.cloudConsent.partial" : "settings.providers.cloudConsent.allowNote")}</span>
          </span>
          <Switch
            hideLabel
            checked={props.consent.allowed}
            disabled={props.accounts.activity() !== undefined}
            onChange={(allowed) => props.accounts.allowInCloud(props.account.key, props.account.ids, allowed)}
          >
            {t("settings.providers.cloudConsent.allow")}
          </Switch>
        </div>
      </Show>
      <Show when={error()}>{(message) => <span role="alert" class="text-icon-warning-base">{message()}</span>}</Show>
    </div>
  )
}

function useRemoveAccount(props: { readonly account: AccountWords; readonly row: HarnessRowProps }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const i18n = useI18n()
  const servedBy = () => servedByList(props.row.snapshot.sources.org.filter((row) => props.account.ids.includes(row.id)).map((row) => row.providerId), i18n.intlTag())
  return async () => {
    const org = props.account.key === ORG_ACCOUNT_KEY
    const confirmed = await requestConfirm(dialog, {
      title: t("settings.providers.agents.removeAccountTitle", { label: props.account.label }),
      ...(org ? { body: t("settings.providers.agents.removeOrgAccountBody", { harnesses: servedBy() }) } : {}),
      confirmLabel: t("settings.providers.agents.removeAccount"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    })
    if (confirmed) await props.row.accounts.remove(props.account.ids)
  }
}

export function AccountItem(props: { readonly account: AccountWords; readonly row: HarnessRowProps; readonly selected: boolean; readonly openConnect: (credentialId?: string) => void }) {
  const t = useAccountsText()
  const i18n = useI18n()
  const accounts = () => props.row.accounts
  const account = () => props.account
  const remove = useRemoveAccount(props)
  const machine = () => account().group === "machine"
  const checkKey = () => (machine() ? machineCheckKey(props.row.harness) : (account().ids[0] ?? account().key))
  return (
    <div class="flex flex-col gap-2.5 border-b border-border-weak-base py-3.5 last:border-b-0" data-slot="account-row" data-account={account().key} data-selected={props.selected ? "true" : "false"}>
      <div class="flex items-start gap-3">
        <RadioItem
          class="min-w-0 flex-1"
          value={account().key}
          disabled={account().disabled}
          data-invalid={account().refused ? "" : undefined}
          title={account().identity}
          label={<AccountTitle account={account()} />}
          description={<AccountLines account={account()} />}
        />
        <span class="-my-1 flex shrink-0 items-center justify-end gap-2">
          <Show when={account().checkedAt}>
            {(at) => <CheckedAge at={at()} t={t} locale={i18n.intlTag()} class="whitespace-nowrap text-12-regular text-text-weak" />}
          </Show>
          <AccountActions
            account={account()}
            checking={accounts().checking(checkKey())}
            removing={accounts().activity()?.kind === "removing"}
            onReconnect={(credentialId) => props.openConnect(credentialId)}
            onCheck={() => (machine() ? accounts().checkMachine(props.row.harness) : accounts().check(checkKey()))}
            onRemove={() => void remove()}
          />
        </span>
      </div>
      <Show when={accounts().onMachine() && account().cloudConsent}>{(consent) => <CloudConsentSwitch account={account()} consent={consent()} accounts={accounts()} />}</Show>
    </div>
  )
}
