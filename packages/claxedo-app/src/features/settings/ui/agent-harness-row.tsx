import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { createSignal, For, Show, type Component } from "solid-js"
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
    class="mt-1.5 size-1.5 shrink-0 rounded-full"
    classList={{
      "bg-icon-success-base": props.tone === "success",
      "bg-icon-critical-base": props.tone === "danger",
      "bg-icon-weak-base": props.tone === "neutral",
    }}
  />
)

/**
 * One agent harness: what it runs on, the accounts it can run on, and the way
 * to add another.
 *
 * The checked radio is the account in use, so the list is the only place that
 * answers "which login" — the header sentence restates it in prose and the two
 * are derived from the same `selected` flag rather than from separate reads.
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

  const remove = async (account: AgentAccount) => {
    try {
      await props.onRemove(account.ids)
    } finally {
      setConfirmingRemove(undefined)
    }
  }

  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={props.id}>
      <div class="flex w-full flex-wrap items-start justify-between gap-4 py-3">
        <div class="flex min-w-0 flex-1 items-start gap-3">
          <ProviderIcon id={props.id} class="size-5 shrink-0 icon-strong-base" />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-14-medium text-text-strong">{props.name}</span>
            <span class="flex min-w-0 items-start gap-1.5" data-component="agent-header-status">
              <HealthDot tone={props.header.tone} />
              <span class="text-13-regular text-text-base">{props.header.sentence}</span>
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
      <div class="mb-3 ml-8 flex flex-col" role="radiogroup" aria-label={props.name} data-component="agent-accounts">
        <For each={props.accounts}>
          {(account) => (
            <div
              class="flex flex-wrap items-center justify-between gap-3 py-1"
              data-component="agent-account"
              data-account={account.key}
              data-selected={account.selected ? "true" : "false"}
            >
              <label class="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="radio"
                  name={group()}
                  class="shrink-0 accent-icon-interactive-base"
                  checked={account.selected}
                  disabled={props.selecting !== undefined}
                  data-action="agent-account-select"
                  onChange={() => void props.onSelect(account)}
                />
                <span class="text-13-regular text-text-strong">{account.label}</span>
                <Show when={account.source}>
                  {(source) => <span class="text-13-regular text-text-weak">{source()}</span>}
                </Show>
                <span class="flex min-w-0 items-start gap-1.5" data-component="agent-account-status">
                  <HealthDot tone={account.tone} />
                  <span class="text-13-regular text-text-weak">
                    {account.when ? `${account.status} · ${account.when}` : account.status}
                  </span>
                </span>
              </label>
              <Show when={account.ids.length > 0}>
                <Show
                  when={confirmingRemove() === account.key}
                  fallback={(
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        as={Button}
                        size="small"
                        variant="ghost"
                        data-action="agent-account-menu"
                        aria-label={language.t("settings.providers.agents.accountMenu", { account: account.label })}
                      >
                        …
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content class="z-[200]">
                          <DropdownMenu.Item
                            data-action="agent-account-check"
                            disabled={props.checking !== undefined}
                            onSelect={() => void props.onCheck(account.ids)}
                          >
                            {props.checking === account.key
                              ? language.t("settings.providers.agents.checking")
                              : language.t("settings.providers.agents.checkNow")}
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            data-action="agent-account-remove"
                            onSelect={() => setConfirmingRemove(account.key)}
                          >
                            {language.t("settings.providers.agents.removeAccount")}
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu>
                  )}
                >
                  <div class="flex shrink-0 items-center gap-2">
                    <span class="text-12-regular text-text-weak">
                      {language.t("settings.providers.agents.removeAccountConfirm")}
                    </span>
                    <Button
                      size="small"
                      variant="primary"
                      disabled={props.removing !== undefined}
                      data-action="agent-account-remove-confirm"
                      onClick={() => void remove(account)}
                    >
                      {props.removing === account.key
                        ? language.t("settings.providers.agents.removingAccount")
                        : language.t("settings.providers.agents.removeAccount")}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={props.removing !== undefined}
                      data-action="agent-account-remove-cancel"
                      onClick={() => setConfirmingRemove(undefined)}
                    >
                      {language.t("common.cancel")}
                    </Button>
                  </div>
                </Show>
              </Show>
            </div>
          )}
        </For>
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
