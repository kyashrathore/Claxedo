import { Button } from "@opencode-ai/ui/button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { RadioList, RadioListItem } from "@opencode-ai/ui/radio-group"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createSignal, For, Show, type Component, type JSX } from "solid-js"
import { ProviderConnectCard } from "@/features/settings/ui/provider-connect-card"
import { ClaxedoIcon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton } from "@/ui/controls/claxedo-icon-button"
import {
  AccountReachMarks,
  ACCOUNT_REACH_KEYS,
  CheckedAge,
  type AccountReach,
} from "@/ui/controls/account-status"
import { harnessConnectContext } from "@/platform/identity/harness-catalog"
import { useLanguage } from "@/platform/i18n/provider"

/** One entry of the harness's account list, resolved down to what a row draws. */
export type AgentAccount = {
  /** The stored row this entry is keyed by, or `machine` for this computer's login. */
  key: string
  /** Every stored row holding this account; empty while the login is only on disk. */
  ids: readonly string[]
  label: string
  /** The second line: where the login lives and what it has spent. */
  detail?: string
  /**
   * What the label does not say and the second line should not carry: how far a
   * partial login reaches, why the entry is not a choice. It hangs off a hint
   * beside the label rather than lengthening the sentence under it.
   */
  note?: string
  /**
   * When the figures on this row were read. The far-right column has room for
   * an age and not for a sentence, so the row spells it rather than being
   * handed words it would have to shorten again.
   */
  checkedAt?: number
  /** The provider's refusal, in words. The row shows it as a ring, not as text. */
  refused?: string
  /** An identity worth having on the row but not worth reading. */
  identity?: string
  /** Where the credential authority says a turn on this account can run. */
  reach: AccountReach
  selected: boolean
  /** This computer's own login for the harness, which is never a stored row. */
  machine?: boolean
  /** Listed, and not a choice. */
  disabled?: boolean
}

/**
 * One agent harness: what it can run on, and the way to add another.
 *
 * The rows carry everything — which login runs next, which one the provider
 * refused, and what to do about it — so the header is the name and the one
 * action no row can offer: adding an account. A refused account is a ring on
 * its own radio and a Reconnect on its own row; nothing else about it is
 * coloured or worded.
 */
export const AgentHarnessRow: Component<{
  id: string
  name: string
  providerId: string
  harness: string
  accounts: readonly AgentAccount[]
  /**
   * Marks the account the harness runs on. Choosing this computer's own login
   * stores nothing: it withdraws the mark from every stored row of the harness.
   */
  onSelect: (account: AgentAccount) => void | Promise<void>
  /** The entry whose switch is in flight. */
  selecting?: string
  onCheck: (account: AgentAccount) => void | Promise<void>
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
   * A hint on the label's own line. The trigger sits inside the radio's
   * `<label>`, where a press would otherwise choose the account, so it swallows
   * its own.
   */
  const LabelHint: Component<{ value: string; component: string; children: JSX.Element }> = (self) => (
    <Tooltip value={self.value} placement="top">
      <span
        class="flex items-center"
        data-component={self.component}
        onClick={(event) => event.preventDefault()}
      >
        {self.children}
      </span>
    </Tooltip>
  )

  /** Whether a workspace in a cloud sandbox can run on this account at all. */
  const Reach: Component<{ account: AgentAccount }> = (self) => (
    <LabelHint value={language.t(ACCOUNT_REACH_KEYS[self.account.reach].note)} component="agent-account-reach">
      <AccountReachMarks
        reach={self.account.reach}
        component="agent-account-reach-marks"
        t={language.t}
        class="flex items-center gap-1"
        iconClass="icon-weak-base"
      />
    </LabelHint>
  )

  /**
   * At rest a row is its label alone. Every action arrives on hover or with
   * keyboard focus — Reconnect included, so a refused row rests as a ring on
   * its radio and nothing else — and a confirming row holds them on screen so
   * the question it just asked cannot vanish under the pointer.
   *
   * The cluster holds its width at rest, so the read time it covers on hover
   * sits where the cluster will be and neither moves when the pointer arrives.
   */
  const AccountActions: Component<{ account: AgentAccount }> = (self) => (
    <Show when={self.account.ids.length > 0 || self.account.machine}>
      <span
        class="flex shrink-0 min-w-11 items-center justify-end gap-1 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        classList={{ "opacity-0": confirmingRemove() !== self.account.key }}
        data-component="agent-account-actions"
      >
        <Show
          when={confirmingRemove() === self.account.key}
          fallback={(
            <>
              <Show when={self.account.refused !== undefined && self.account.ids.length > 0}>
                <Button
                  size="small"
                  variant="secondary"
                  data-action="agent-reconnect"
                  onClick={() => setConnecting({ credentialId: self.account.ids[0] })}
                >
                  {language.t("settings.providers.agents.reconnectAccount")}
                </Button>
              </Show>
              <ClaxedoIconButton
                icon="reload"
                size="small"
                variant="ghost"
                data-action="agent-account-check"
                aria-label={language.t("settings.providers.agents.checkAccount")}
                disabled={props.checking !== undefined}
                onClick={() => void props.onCheck(self.account)}
              />
              <Show when={self.account.ids.length > 0}>
                <ClaxedoIconButton
                  icon="trash"
                  size="small"
                  variant="ghost"
                  data-action="agent-account-remove"
                  aria-label={language.t("settings.providers.agents.removeAccount")}
                  onClick={() => setConfirmingRemove(self.account.key)}
                />
              </Show>
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
          <Show when={connecting() === undefined}>
            <Button
              size="large"
              variant="ghost"
              data-action="agent-add-account"
              onClick={() => setConnecting({})}
            >
              {language.t("settings.providers.agents.addAccount")}
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
                  disabled={account.disabled === true}
                  invalid={account.refused !== undefined}
                  data-component="agent-account"
                  data-account={account.key}
                  data-selected={account.selected ? "true" : "false"}
                  title={account.identity}
                  label={(
                    <span class="flex flex-wrap items-center gap-1.5">
                      <span class="text-13-regular text-text-strong">{account.label}</span>
                      <Show when={account.note}>
                        {(note) => (
                          <LabelHint value={note()} component="agent-account-note">
                            <ClaxedoIcon
                              name="help"
                              size="small"
                              class="icon-weak-base"
                              role="img"
                              aria-hidden="false"
                              aria-label={note()}
                            />
                          </LabelHint>
                        )}
                      </Show>
                      <Reach account={account} />
                    </span>
                  )}
                  description={(account.detail ?? account.refused) !== undefined
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
                  <span class="relative flex shrink-0 items-center justify-end">
                    <Show when={account.checkedAt}>
                      {(at) => (
                        <CheckedAge
                          at={at()}
                          component="agent-account-checked"
                          t={language.t}
                          locale={language.locale()}
                          class="pointer-events-none absolute right-0 whitespace-nowrap text-13-regular text-text-weak transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                        />
                      )}
                    </Show>
                    <AccountActions account={account} />
                  </span>
                </RadioListItem>
              )}
            </For>
          </RadioList>
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
