import { Button } from "@opencode-ai/ui/button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { RadioList, RadioListItem } from "@opencode-ai/ui/radio-group"
import { createSignal, For, Show, type Component, type JSX } from "solid-js"
import { ProviderConnectCard } from "@/features/settings/ui/provider-connect-card"
import { useLanguage } from "@/platform/i18n/provider"

/** The colour the single status dot carries; nothing else on the row is coloured. */
export type AgentTone = "success" | "danger" | "neutral"

/** What the harness runs on, in one sentence, plus the one action that changes it. */
export type AgentHeader = {
  tone: AgentTone
  sentence: string
  action?: { kind: "connect" } | { kind: "reconnect"; credentialId: string }
}

/** One entry of the harness's account list, already in words. */
export type AgentAccount = {
  /** The stored row this entry is keyed by, or `machine` for this computer's login. */
  key: string
  /** Every stored row holding this account; empty while the login is only on disk. */
  ids: readonly string[]
  label: string
  /** Where the login lives, or the account's identity at the provider. */
  source?: string
  tone: AgentTone
  /** The verdict in words: "Working", "Expired", "Not checked". */
  status: string
  /** When that verdict was made, already in words. */
  when?: string
  selected: boolean
  /** The scan found this login on this computer; choosing it stores it first. */
  machine?: boolean
}

const HealthDot: Component<{ tone: AgentTone }> = (props) => (
  <span
    aria-hidden="true"
    data-component="agent-status-dot"
    data-tone={props.tone}
    class="size-1.5 shrink-0 rounded-full"
    classList={{
      "bg-icon-success-base": props.tone === "success",
      "bg-icon-critical-base": props.tone === "danger",
      "bg-icon-weak-base": props.tone === "neutral",
    }}
  />
)

const TextAction: Component<{ action: string; disabled?: boolean; onClick: () => void; children: JSX.Element }> = (props) => (
  <button
    type="button"
    class="shrink-0 border-none bg-transparent p-0 text-13-regular text-text-weak hover:text-text-strong disabled:opacity-60"
    data-action={props.action}
    disabled={props.disabled}
    onClick={() => props.onClick()}
  >
    {props.children}
  </button>
)

/**
 * One agent harness: what it runs on, the accounts it can run on, and the way
 * to add another.
 *
 * A lone entry is not listed — the header sentence already names the only login
 * there is to name, and a list under it reads as a second account — so its
 * Check and Remove sit on the header line instead. The list appears once there
 * is a choice to make, and its checked radio is the same `selected` flag the
 * header sentence is derived from.
 */
export const AgentHarnessRow: Component<{
  id: string
  name: string
  providerId: string
  harness: string
  header: AgentHeader
  accounts: readonly AgentAccount[]
  /** Marks the account the harness runs on; a machine login is stored first. */
  onSelect: (account: AgentAccount) => void | Promise<void>
  /** The entry whose switch is in flight. */
  selecting?: string
  onCheck: (credentialIds: readonly string[]) => void | Promise<void>
  /** The entry whose check is in flight. */
  checking?: string
  onRemove: (credentialIds: readonly string[]) => void | Promise<void>
  /** The entry whose removal is in flight. */
  removing?: string
  onConnected?: () => void | Promise<void>
}> = (props) => {
  const language = useLanguage()
  const [connecting, setConnecting] = createSignal<{ credentialId?: string }>()
  const [confirmingRemove, setConfirmingRemove] = createSignal<string>()
  const group = () => `agent-account-${props.harness}`
  const listed = () => (props.accounts.length > 1 ? props.accounts : [])
  const sole = () => (props.accounts.length === 1 ? props.accounts[0] : undefined)
  const selectedKey = () => props.accounts.find((account) => account.selected)?.key

  const remove = async (account: AgentAccount) => {
    try {
      await props.onRemove(account.ids)
    } finally {
      setConfirmingRemove(undefined)
    }
  }

  const AccountActions: Component<{ account: AgentAccount }> = (self) => (
    <Show when={self.account.ids.length > 0}>
      <Show
        when={confirmingRemove() === self.account.key}
        fallback={(
          <span class="flex shrink-0 items-center gap-3">
            <TextAction
              action="agent-account-check"
              disabled={props.checking !== undefined}
              onClick={() => void props.onCheck(self.account.ids)}
            >
              {props.checking === self.account.key
                ? language.t("settings.providers.agents.checking")
                : language.t("settings.providers.agents.checkAccount")}
            </TextAction>
            <TextAction action="agent-account-remove" onClick={() => setConfirmingRemove(self.account.key)}>
              {language.t("settings.providers.agents.removeAccount")}
            </TextAction>
          </span>
        )}
      >
        <span class="flex shrink-0 items-center gap-3">
          <span class="text-13-regular text-text-weak">
            {language.t("settings.providers.agents.removeAccountConfirm")}
          </span>
          <TextAction
            action="agent-account-remove-confirm"
            disabled={props.removing !== undefined}
            onClick={() => void remove(self.account)}
          >
            {props.removing === self.account.key
              ? language.t("settings.providers.agents.removingAccount")
              : language.t("settings.providers.agents.removeAccount")}
          </TextAction>
          <TextAction
            action="agent-account-remove-cancel"
            disabled={props.removing !== undefined}
            onClick={() => setConfirmingRemove(undefined)}
          >
            {language.t("common.cancel")}
          </TextAction>
        </span>
      </Show>
    </Show>
  )

  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={props.id}>
      <div class="flex w-full flex-wrap items-start justify-between gap-4 py-3">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <ProviderIcon id={props.id} class="size-5 shrink-0 icon-strong-base" />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-14-medium text-text-strong">{props.name}</span>
            <span class="flex min-w-0 flex-wrap items-center gap-3">
              <span class="flex min-w-0 items-center gap-1.5" data-component="agent-header-status">
                <HealthDot tone={props.header.tone} />
                <span class="text-13-regular text-text-base">{props.header.sentence}</span>
              </span>
              <Show when={sole()}>{(account) => <AccountActions account={account()} />}</Show>
            </span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2" data-component="provider-actions">
          <Show when={connecting() === undefined && props.header.action}>
            {(action) => (
              <Button
                size="large"
                variant={action().kind === "reconnect" ? "primary" : "ghost"}
                data-action={action().kind === "reconnect" ? "agent-reconnect" : "agent-connect"}
                onClick={() => {
                  const next = action()
                  setConnecting(next.kind === "reconnect" ? { credentialId: next.credentialId } : {})
                }}
              >
                {action().kind === "reconnect"
                  ? language.t("settings.providers.agents.reconnectAccount")
                  : language.t("common.connect")}
              </Button>
            )}
          </Show>
          <Show when={connecting()}>
            <span class="text-12-regular text-text-interactive-base">{language.t("settings.providers.connect.open")}</span>
          </Show>
        </div>
      </div>
      <div class="mb-3 ml-8 flex flex-col" data-component="agent-accounts">
        <Show when={listed().length > 0}>
          <RadioList
            name={group()}
            aria-label={props.name}
            value={selectedKey()}
            disabled={props.selecting !== undefined}
            onChange={(key) => {
              const chosen = props.accounts.find((account) => account.key === key)
              if (chosen) void props.onSelect(chosen)
            }}
          >
            <For each={listed()}>
              {(account) => (
                <RadioListItem
                  class="py-1"
                  value={account.key}
                  data-component="agent-account"
                  data-account={account.key}
                  data-selected={account.selected ? "true" : "false"}
                  label={(
                    <span class="flex min-w-0 flex-wrap items-center gap-2">
                      <span class="text-13-regular text-text-strong">{account.label}</span>
                      <Show when={account.source}>
                        {(source) => <span class="text-13-regular text-text-weak">{source()}</span>}
                      </Show>
                      <span class="flex min-w-0 items-center gap-1.5" data-component="agent-account-status">
                        <HealthDot tone={account.tone} />
                        <span class="text-13-regular text-text-weak">
                          {account.when ? `${account.status} · ${account.when}` : account.status}
                        </span>
                      </span>
                    </span>
                  )}
                >
                  <AccountActions account={account} />
                </RadioListItem>
              )}
            </For>
          </RadioList>
        </Show>
        <div class="py-1">
          <button
            type="button"
            class="border-none bg-transparent p-0 text-13-regular text-text-interactive-base"
            data-action="agent-add-account"
            onClick={() => setConnecting({})}
          >
            {props.accounts.length > 0
              ? language.t("settings.providers.agents.addAnotherAccount")
              : language.t("settings.providers.agents.addFirstAccount")}
          </button>
        </div>
      </div>
      <Show when={connecting()}>
        {(open) => (
          <ProviderConnectCard
            provider={props.providerId}
            providerName={props.name}
            harness={props.harness}
            credentialId={open().credentialId}
            onConnected={props.onConnected}
            onClose={() => setConnecting(undefined)}
          />
        )}
      </Show>
    </div>
  )
}
