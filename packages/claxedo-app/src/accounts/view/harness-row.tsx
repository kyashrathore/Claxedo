import { createSignal, For, onMount, Show } from "solid-js"
import { useAccess } from "@/access"
import { harnessConnectContext, harnessIcon } from "@/lib/harness-catalog"
import { useI18n } from "@/i18n"
import { ClaxedoIcon, requestConfirm, useDialog, Button, ProviderIcon, RadioGroup, RadioItem, Switch } from "@/ui"
import type { AccountWords, CloudConsent } from "../account-words"
import { useAccountsText } from "../i18n"
import type { OrganizationConnect } from "../connect-form"
import { machineCheckKey, ORG_ACCOUNT_KEY, organizationTarget, replacedAccountLabel, selectedAccountKey, type AccountsSnapshot, type Harness } from "../model"
import type { Accounts } from "../store"
import { AccountActions, LabelHint, Reach } from "./account-actions"
import { useAccountRows } from "./account-rows"
import { CheckedAge } from "./account-status"
import { CloudChoiceHint } from "./cloud-choice-hint"
import { DrawerProviderConnect } from "./connect-drawer"
import { useServedBy } from "./served-by"

export type HarnessRowProps = {
  readonly harness: Harness
  readonly snapshot: AccountsSnapshot
  readonly accounts: Accounts
  readonly headerless?: boolean
  readonly onAddAccountRef?: (open: () => void) => void
}

function AccountLabel(props: { readonly account: AccountWords; readonly onMachine: boolean; readonly machineName?: string }) {
  const t = useAccountsText()
  const source = () => {
    if (props.account.source === "stored") return t("settings.providers.agents.sourceStored")
    if (props.account.source === "machine") return t("settings.providers.agents.sourceMachine", { machine: props.machineName ?? t("settings.providers.agents.machineFallback") })
    return undefined
  }
  return (
    <span class="flex flex-wrap items-center gap-1.5">
      <span class="text-13-regular text-text-strong">{props.account.label}</span>
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
      <Show when={props.onMachine ? props.account.reach : undefined}>{(reach) => <Reach reach={reach()} source={source()} />}</Show>
    </span>
  )
}

function AccountDescription(props: { readonly account: AccountWords }) {
  return (
    <span class="flex flex-col">
      <Show when={props.account.detail}>{(detail) => <span class="text-13-regular text-text-weak">{detail()}</span>}</Show>
      <Show when={props.account.cloudNote}>{(note) => <span class="text-12-regular text-text-weak">{note()}</span>}</Show>
    </span>
  )
}

function CloudConsentSwitch(props: { readonly account: AccountWords; readonly consent: CloudConsent; readonly accounts: Accounts }) {
  const t = useAccountsText()
  const error = () => props.accounts.scopeErrors()[props.account.key]
  return (
    <div class="flex flex-col gap-1 pl-6 text-12-regular text-text-weak">
      <Show when={props.consent.deliverable} fallback={<span>{t("settings.providers.cloudConsent.unavailable")}</span>}>
        <Switch
          checked={props.consent.allowed}
          disabled={props.accounts.activity() !== undefined}
          onChange={(allowed) => props.accounts.allowInCloud(props.account.key, props.account.ids, allowed)}
        >
          {t("settings.providers.cloudConsent.allow")}
        </Switch>
        <Show when={props.consent.partial}>
          <span>{t("settings.providers.cloudConsent.partial")}</span>
        </Show>
      </Show>
      <Show when={error()}>{(message) => <span role="alert" class="text-icon-warning-base">{message()}</span>}</Show>
    </div>
  )
}

function useRemoveAccount(props: { readonly account: AccountWords; readonly row: HarnessRowProps }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const listServedBy = useServedBy()
  const servedBy = () => listServedBy(props.row.snapshot.sources.org.filter((row) => props.account.ids.includes(row.id)).map((row) => row.providerId))
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

function AccountItem(props: { readonly account: AccountWords; readonly row: HarnessRowProps; readonly selected: boolean; readonly openConnect: (credentialId?: string) => void }) {
  const t = useAccountsText()
  const i18n = useI18n()
  const accounts = () => props.row.accounts
  const account = () => props.account
  const remove = useRemoveAccount(props)
  const checkKey = () => (account().machine ? machineCheckKey(props.row.harness) : (account().ids[0] ?? account().key))
  return (
    <div class="flex flex-col">
      <div class="group flex flex-wrap items-start gap-2 py-1" data-slot="account-row" data-account={account().key} data-selected={props.selected ? "true" : "false"}>
        <RadioItem
          class="min-w-0 flex-1 basis-56"
          value={account().key}
          disabled={account().disabled}
          data-invalid={account().refused ? "" : undefined}
          title={account().identity}
          label={<AccountLabel account={account()} onMachine={accounts().onMachine()} machineName={accounts().machineName()} />}
          description={account().detail === undefined && account().cloudNote === undefined ? undefined : <AccountDescription account={account()} />}
        />
        <span class="ml-auto flex shrink-0 items-center justify-end gap-2">
          <Show when={account().checkedAt}>
            {(at) => <CheckedAge at={at()} t={t} locale={i18n.intlTag()} class="whitespace-nowrap text-13-regular text-text-weak" />}
          </Show>
          <AccountActions
            account={account()}
            checking={accounts().checking(checkKey())}
            removing={accounts().activity()?.kind === "removing"}
            onReconnect={(credentialId) => props.openConnect(credentialId)}
            onCheck={() => (account().machine ? accounts().checkMachine(props.row.harness) : accounts().check(checkKey()))}
            onRemove={() => void remove()}
          />
        </span>
      </div>
      <Show when={accounts().onMachine() && account().cloudConsent}>{(consent) => <CloudConsentSwitch account={account()} consent={consent()} accounts={accounts()} />}</Show>
    </div>
  )
}

function HarnessHeader(props: { readonly harness: Harness; readonly accounts: Accounts; readonly connecting: boolean; readonly onAdd: () => void }) {
  const t = useAccountsText()
  return (
    <div class="flex w-full flex-wrap items-center justify-between gap-4 py-3">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <ProviderIcon id={harnessIcon(props.harness.id)} class="size-5 shrink-0 icon-strong-base" />
        <span class="text-14-medium text-text-strong">{props.harness.label}</span>
        <CloudChoiceHint harness={props.harness} accounts={props.accounts} />
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Show when={props.connecting} fallback={<Button size="large" variant="ghost" data-action="agent-add-account" onClick={() => props.onAdd()}>{t("settings.providers.agents.addAccount")}</Button>}>
          <span class="text-12-regular text-text-interactive-base">{t("settings.providers.connect.open")}</span>
        </Show>
      </div>
    </div>
  )
}

function NoAccount(props: { readonly harness: Harness; readonly onAdd: () => void }) {
  const t = useAccountsText()
  return (
    <div class="flex flex-wrap items-center justify-between gap-3 py-2">
      <span class="text-13-regular text-text-weak">{t("settings.providers.agents.empty", { harness: props.harness.label })}</span>
      <Button size="small" variant="neutral" data-action="agent-add-account" onClick={() => props.onAdd()}>{t("settings.providers.agents.addAccount")}</Button>
    </div>
  )
}

function useOrganizationConnect(props: HarnessRowProps): () => OrganizationConnect | undefined {
  const access = useAccess()
  const servedBy = useServedBy()
  return () => {
    const target = organizationTarget(props.harness, props.snapshot, access.can("accounts.manageOrg", props.snapshot.sources))
    return target ? { ...target, servedBy: servedBy([target.vendorProvider]) } : undefined
  }
}

export function AgentHarnessRow(props: HarnessRowProps) {
  const dialog = useDialog()
  const [connecting, setConnecting] = createSignal(false)
  const rows = useAccountRows(() => props.harness, () => props.snapshot, () => props.accounts)
  const organization = useOrganizationConnect(props)
  const selected = () => selectedAccountKey(props.harness, props.snapshot)
  const openConnect = (credentialId?: string) => {
    setConnecting(true)
    const context = harnessConnectContext(props.harness.id, props.harness.label)
    const replaces = (methodType: string) => replacedAccountLabel(props.harness.connectProvider, props.snapshot, methodType)
    const org = credentialId ? undefined : organization()
    void dialog.show(
      () => (
        <DrawerProviderConnect
          provider={props.harness.connectProvider}
          context={context}
          harness={props.harness.id}
          {...(credentialId ? { credentialId } : {})}
          {...(org ? { organization: org } : {})}
          replaces={replaces}
          onConnected={() => props.accounts.rescan()}
        />
      ),
      () => setConnecting(false),
    )
  }
  onMount(() => props.onAddAccountRef?.(() => openConnect()))
  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={harnessIcon(props.harness.id)}>
      <Show when={!props.headerless}>
        <HarnessHeader harness={props.harness} accounts={props.accounts} connecting={connecting()} onAdd={() => openConnect()} />
      </Show>
      <div class="mb-3 flex flex-col" classList={{ "ml-8": !props.headerless }}>
        <Show when={rows().length > 0} fallback={<NoAccount harness={props.harness} onAdd={() => openConnect()} />}>
          <RadioGroup
            name={`agent-account-${props.harness.id}`}
            aria-label={props.harness.label}
            value={selected()}
            disabled={props.accounts.activity()?.kind === "selecting"}
            onChange={(key: string) => {
              const chosen = rows().find((account) => account.key === key)
              if (chosen) props.accounts.select(props.harness, chosen.key, chosen.ids)
            }}
          >
            <For each={rows()}>{(account) => <AccountItem account={account} row={props} selected={selected() === account.key} openConnect={openConnect} />}</For>
          </RadioGroup>
        </Show>
      </div>
    </div>
  )
}
