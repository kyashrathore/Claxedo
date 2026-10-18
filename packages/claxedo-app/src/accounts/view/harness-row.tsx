import { createSignal, For, onMount, Show } from "solid-js"
import { useAccess } from "@/access"
import { harnessConnectContext, harnessIcon } from "@/lib/harness-catalog"
import { useI18n } from "@/i18n"
import { SettingsList } from "@/settings"
import { useDialog, Button, ProviderIcon, RadioGroup } from "@/ui"
import { groupAccounts, type AccountGroup, type AccountWords } from "../account-words"
import type { OrganizationConnect } from "../connect-form"
import { useAccountsText, type AccountsKey } from "../i18n"
import { organizationTarget, replacedAccountLabel, selectedAccountKey, servedByList, type AccountsSnapshot, type Harness } from "../model"
import type { Accounts } from "../store"
import { AccountItem } from "./account-item"
import { useAccountRows } from "./account-rows"
import { CloudChoiceHelp } from "./cloud-choice-help"
import { DrawerProviderConnect } from "./connect-drawer"

export type HarnessRowProps = {
  readonly harness: Harness
  readonly snapshot: AccountsSnapshot
  readonly accounts: Accounts
  readonly headerless?: boolean
  readonly onAddAccountRef?: (open: () => void) => void
}

const GROUP_LABEL = {
  stored: "settings.providers.agents.group.stored",
  machine: "settings.providers.agents.group.machine",
  org: "settings.providers.agents.group.org",
} as const satisfies Record<AccountGroup, AccountsKey>

function AccountGroups(props: { readonly rows: readonly AccountWords[]; readonly row: HarnessRowProps; readonly selected: string | undefined; readonly openConnect: (credentialId?: string) => void }) {
  const t = useAccountsText()
  const groups = () => groupAccounts(props.rows)
  return (
    <For each={groups()}>
      {(group) => (
        <div class="flex flex-col gap-1.5">
          <Show when={groups().length > 1}>
            <span class="px-0.5 text-12-medium text-text-weak">{t(GROUP_LABEL[group.group])}</span>
          </Show>
          <SettingsList>
            <For each={group.rows}>{(account) => <AccountItem account={account} row={props.row} selected={props.selected === account.key} openConnect={props.openConnect} />}</For>
          </SettingsList>
        </div>
      )}
    </For>
  )
}

function HarnessHeader(props: { readonly harness: Harness; readonly accounts: Accounts; readonly connecting: boolean; readonly onAdd: () => void }) {
  const t = useAccountsText()
  return (
    <div class="flex w-full flex-wrap items-center justify-between gap-4">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <ProviderIcon id={harnessIcon(props.harness.id)} class="size-5 shrink-0 icon-strong-base" />
        <span class="text-14-medium text-text-strong">{props.harness.label}</span>
        <CloudChoiceHelp harness={props.harness} accounts={props.accounts} />
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
    <SettingsList>
      <div class="flex flex-wrap items-center justify-between gap-3 py-3">
        <span class="text-13-regular text-text-weak">{t("settings.providers.agents.empty", { harness: props.harness.label })}</span>
        <Button size="small" variant="neutral" data-action="agent-add-account" onClick={() => props.onAdd()}>{t("settings.providers.agents.addAccount")}</Button>
      </div>
    </SettingsList>
  )
}

function useOrganizationConnect(props: HarnessRowProps): () => OrganizationConnect | undefined {
  const access = useAccess()
  const i18n = useI18n()
  return () => {
    const target = organizationTarget(props.harness, props.snapshot, access.can("accounts.manageOrg", props.snapshot.sources))
    return target ? { ...target, servedBy: servedByList([target.vendorProvider], i18n.intlTag()) } : undefined
  }
}

function useConnect(props: HarnessRowProps) {
  const dialog = useDialog()
  const [connecting, setConnecting] = createSignal(false)
  const organization = useOrganizationConnect(props)
  const open = (credentialId?: string) => {
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
  return { connecting, open }
}

export function AgentHarnessRow(props: HarnessRowProps) {
  const connect = useConnect(props)
  const rows = useAccountRows(() => props.harness, () => props.snapshot, () => props.accounts)
  const selected = () => selectedAccountKey(props.harness, props.snapshot)
  onMount(() => props.onAddAccountRef?.(() => connect.open()))
  return (
    <div class="flex flex-col gap-3" data-provider={harnessIcon(props.harness.id)}>
      <Show when={!props.headerless}>
        <HarnessHeader harness={props.harness} accounts={props.accounts} connecting={connect.connecting()} onAdd={() => connect.open()} />
      </Show>
      <Show when={rows().length > 0} fallback={<NoAccount harness={props.harness} onAdd={() => connect.open()} />}>
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
          <AccountGroups rows={rows()} row={props} selected={selected()} openConnect={connect.open} />
        </RadioGroup>
      </Show>
    </div>
  )
}
