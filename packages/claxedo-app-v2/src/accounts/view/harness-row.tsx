import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { harnessConnectContext, harnessIcon } from "@/lib/harness-catalog"
import { useI18n } from "@/i18n"
import { ClaxedoIcon, useDialog, Button, ProviderIcon, RadioList, RadioListItem } from "@/ui"
import { useWindowName } from "@/usage"
import { machineLoginWords, storedAccountWords, type AccountWords } from "../account-words"
import { useAccountsText } from "../i18n"
import { harnessAccounts, machineLoginOf, selectedAccountKey, type AccountsSnapshot, type Harness } from "../model"
import type { Accounts } from "../store"
import { AccountActions, LabelHint, Reach } from "./account-actions"
import { CheckedAge } from "./account-status"
import { DialogProviderConnect } from "./connect-dialog"

export type HarnessRowProps = {
  readonly harness: Harness
  readonly snapshot: AccountsSnapshot
  readonly accounts: Accounts
  readonly headerless?: boolean
  readonly onAddAccountRef?: (open: () => void) => void
}

function useAccountRows(props: HarnessRowProps) {
  const t = useAccountsText()
  const windowName = useWindowName()
  return createMemo((): AccountWords[] => {
    const words = { t, windowName }
    const stored = harnessAccounts(props.harness, props.snapshot.stored).map((row) => storedAccountWords(words, row, props.accounts.liveChecks()[row.id]))
    const login = machineLoginOf(props.harness, props.snapshot)
    return login ? [...stored, machineLoginWords(words, login, props.harness, props.snapshot)] : stored
  })
}

function AccountLabel(props: { readonly account: AccountWords }) {
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
      <Show when={props.account.reach}>{(reach) => <Reach reach={reach()} />}</Show>
    </span>
  )
}

function AccountItem(props: { readonly account: AccountWords; readonly row: HarnessRowProps; readonly selected: boolean; readonly openConnect: (credentialId?: string) => void }) {
  const t = useAccountsText()
  const i18n = useI18n()
  const [confirming, setConfirming] = createSignal(false)
  const accounts = () => props.row.accounts
  const activity = () => accounts().activity()
  const account = () => props.account
  return (
    <RadioListItem
      class="group py-1"
      value={account().key}
      disabled={account().disabled}
      invalid={account().refused}
      data-account={account().key}
      data-selected={props.selected ? "true" : "false"}
      title={account().identity}
      label={<AccountLabel account={account()} />}
      description={account().detail === undefined ? undefined : <span class="text-13-regular text-text-weak">{account().detail}</span>}
    >
      <span class="relative flex shrink-0 items-center justify-end">
        <Show when={account().checkedAt}>
          {(at) => (
            <CheckedAge
              at={at()}
              t={t}
              locale={i18n.intlTag()}
              class="pointer-events-none absolute right-0 whitespace-nowrap text-13-regular text-text-weak transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
            />
          )}
        </Show>
        <AccountActions
          account={account()}
          confirming={confirming()}
          checking={activity()?.kind === "checking"}
          removing={activity()?.kind === "removing" ? activity()?.key : undefined}
          onReconnect={(credentialId) => props.openConnect(credentialId)}
          onCheck={() => (account().machine ? accounts().checkMachine(props.row.harness) : accounts().check(account().ids[0] ?? account().key))}
          onConfirm={setConfirming}
          onRemove={() => void accounts().remove(account().ids).finally(() => setConfirming(false))}
        />
      </span>
    </RadioListItem>
  )
}

function HarnessHeader(props: { readonly harness: Harness; readonly connecting: boolean; readonly onAdd: () => void }) {
  const t = useAccountsText()
  return (
    <div class="flex w-full flex-wrap items-center justify-between gap-4 py-3">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <ProviderIcon id={harnessIcon(props.harness.id)} class="size-5 shrink-0 icon-strong-base" />
        <span class="text-14-medium text-text-strong">{props.harness.label}</span>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Show when={props.connecting} fallback={<Button size="large" variant="ghost" data-action="agent-add-account" onClick={() => props.onAdd()}>{t("settings.providers.agents.addAccount")}</Button>}>
          <span class="text-12-regular text-text-interactive-base">{t("settings.providers.connect.open")}</span>
        </Show>
      </div>
    </div>
  )
}

export function AgentHarnessRow(props: HarnessRowProps) {
  const dialog = useDialog()
  const [connecting, setConnecting] = createSignal(false)
  const rows = useAccountRows(props)
  const selected = () => selectedAccountKey(props.harness, props.snapshot)
  const openConnect = (credentialId?: string) => {
    setConnecting(true)
    const context = harnessConnectContext(props.harness.id, props.harness.label)
    void dialog.show(
      () => <DialogProviderConnect provider={props.harness.connectProvider} context={context} harness={props.harness.id} {...(credentialId ? { credentialId } : {})} onConnected={() => props.accounts.rescan()} />,
      () => setConnecting(false),
    )
  }
  onMount(() => props.onAddAccountRef?.(() => openConnect()))
  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={harnessIcon(props.harness.id)}>
      <Show when={!props.headerless}>
        <HarnessHeader harness={props.harness} connecting={connecting()} onAdd={() => openConnect()} />
      </Show>
      <div class="mb-3 flex flex-col" classList={{ "ml-8": !props.headerless }}>
        <Show when={rows().length > 0}>
          <RadioList
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
          </RadioList>
        </Show>
      </div>
    </div>
  )
}
