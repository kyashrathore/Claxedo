import { Button } from "@opencode-ai/ui/button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { RadioList, RadioListItem } from "@opencode-ai/ui/radio-group"
import { createSignal, For, Show, type Component } from "solid-js"
import { ProviderConnectCard } from "@/features/settings/ui/provider-connect-card"
import { ClaxedoIconButton } from "@/ui/controls/claxedo-icon-button"
import { harnessConnectContext } from "@/platform/identity/harness-catalog"
import { useLanguage } from "@/platform/i18n/provider"

/** One entry of the harness's account list, already in words. */
export type AgentAccount = {
  /** The stored row this entry is keyed by, or `machine` for this computer's login. */
  key: string
  /** Every stored row holding this account; empty while the login is only on disk. */
  ids: readonly string[]
  label: string
  /** The second line: where the login lives, its usage, when it was checked. */
  detail?: string
  /** The provider's refusal, in words. The row shows it as a ring, not as text. */
  refused?: string
  /** An identity worth having on the row but not worth reading. */
  identity?: string
  selected: boolean
  /** The scan found this login on this computer; choosing it stores it first. */
  machine?: boolean
}

/**
 * One agent harness: what it can run on, and the way to add another.
 *
 * The rows carry everything — which login runs next, which one the provider
 * refused, and what to do about it — so the header is the name alone, plus the
 * one button there is nothing else to say with: a harness with no account at
 * all. A refused account is a ring on its own radio and a Reconnect on its own
 * row; nothing else about it is coloured or worded.
 */
export const AgentHarnessRow: Component<{
  id: string
  name: string
  providerId: string
  harness: string
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
  const selectedKey = () => props.accounts.find((account) => account.selected)?.key

  const remove = async (account: AgentAccount) => {
    try {
      await props.onRemove(account.ids)
    } finally {
      setConfirmingRemove(undefined)
    }
  }

  /**
   * At rest a row is its label alone. The actions arrive on hover or with
   * keyboard focus, and a confirming row holds them on screen so the question
   * it just asked cannot vanish under the pointer.
   */
  const AccountActions: Component<{ account: AgentAccount }> = (self) => (
    <Show when={self.account.ids.length > 0}>
      <span
        class="flex shrink-0 items-center gap-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        classList={{ "opacity-0": confirmingRemove() !== self.account.key }}
        data-component="agent-account-actions"
      >
        <Show
          when={confirmingRemove() === self.account.key}
          fallback={(
            <>
              <ClaxedoIconButton
                icon="reload"
                size="small"
                variant="ghost"
                data-action="agent-account-check"
                aria-label={language.t("settings.providers.agents.checkAccount")}
                disabled={props.checking !== undefined}
                onClick={() => void props.onCheck(self.account.ids)}
              />
              <ClaxedoIconButton
                icon="trash"
                size="small"
                variant="ghost"
                data-action="agent-account-remove"
                aria-label={language.t("settings.providers.agents.removeAccount")}
                onClick={() => setConfirmingRemove(self.account.key)}
              />
            </>
          )}
        >
          <span class="text-13-regular text-text-weak">
            {language.t("settings.providers.agents.removeAccountConfirm")}
          </span>
          <Button
            size="small"
            variant="primary"
            disabled={props.removing !== undefined}
            data-action="agent-account-remove-confirm"
            onClick={() => void remove(self.account)}
          >
            {props.removing === self.account.key
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
        </Show>
      </span>
    </Show>
  )

  return (
    <div class="border-b border-border-weak-base last:border-none" data-provider={props.id}>
      <div class="flex w-full flex-wrap items-center justify-between gap-4 py-3">
        <div class="flex min-w-0 flex-1 items-center gap-3">
          <ProviderIcon id={props.id} class="size-5 shrink-0 icon-strong-base" />
          <span class="text-14-medium text-text-strong">{props.name}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2" data-component="provider-actions">
          <Show when={connecting() === undefined && props.accounts.length === 0}>
            <Button
              size="large"
              variant="ghost"
              data-action="agent-connect"
              onClick={() => setConnecting({})}
            >
              {language.t("settings.providers.agents.addFirstAccount")}
            </Button>
          </Show>
          <Show when={connecting()}>
            <span class="text-12-regular text-text-interactive-base">{language.t("settings.providers.connect.open")}</span>
          </Show>
        </div>
      </div>
      <div class="mb-3 ml-8 flex flex-col" data-component="agent-accounts">
        <Show when={props.accounts.length > 0}>
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
            <For each={props.accounts}>
              {(account) => (
                <RadioListItem
                  class="group py-1"
                  value={account.key}
                  invalid={account.refused !== undefined}
                  data-component="agent-account"
                  data-account={account.key}
                  data-selected={account.selected ? "true" : "false"}
                  title={[account.refused, account.identity].filter(Boolean).join(" · ") || undefined}
                  label={<span class="text-13-regular text-text-strong">{account.label}</span>}
                  description={account.detail ?? account.refused
                    ? (
                      <>
                        <Show when={account.detail}>
                          {(detail) => <span class="text-13-regular text-text-weak">{detail()}</span>}
                        </Show>
                        <Show when={account.refused}>
                          {(refused) => <span class="sr-only" data-component="agent-account-refusal">{refused()}</span>}
                        </Show>
                      </>
                    )
                    : undefined}
                >
                  <span class="flex shrink-0 items-center gap-2">
                    <Show when={account.refused !== undefined && account.ids.length > 0}>
                      <Button
                        size="small"
                        variant="secondary"
                        data-action="agent-reconnect"
                        onClick={() => setConnecting({ credentialId: account.ids[0] })}
                      >
                        {language.t("settings.providers.agents.reconnectAccount")}
                      </Button>
                    </Show>
                    <AccountActions account={account} />
                  </span>
                </RadioListItem>
              )}
            </For>
          </RadioList>
        </Show>
        {/* Indented past the radio column so the link starts where the labels do. */}
        <Show when={props.accounts.length > 0}>
          <div class="py-1 pl-[22px]">
            <button
              type="button"
              class="border-none bg-transparent p-0 text-13-regular text-text-interactive-base"
              data-action="agent-add-account"
              onClick={() => setConnecting({})}
            >
              {language.t("settings.providers.agents.addAnotherAccount")}
            </button>
          </div>
        </Show>
      </div>
      <Show when={connecting()}>
        {(open) => (
          <ProviderConnectCard
            provider={props.providerId}
            context={harnessConnectContext(props.harness, props.name)}
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
