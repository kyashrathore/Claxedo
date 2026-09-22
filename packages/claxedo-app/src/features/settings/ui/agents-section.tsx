import { Spinner } from "@opencode-ai/ui/spinner"
import { Show, type Component } from "solid-js"
import { localHarnessChecks, type LocalHarnessCheck } from "@/features/settings/app-ports"
import { useMachineAccounts } from "@/features/settings/machine-accounts"
import { SettingsEmpty, SettingsList } from "@/ui/controls/settings-list"
import { AgentHarnessRow } from "@/features/settings/ui/agent-harness-row"
import { harnessIcon } from "@/platform/identity/harness-catalog"
import { useLanguage } from "@/platform/i18n/provider"

/** The machine harness that answers for a native harness id, where one does. */
export function machineHarnessFor(id: string): LocalHarnessCheck | undefined {
  return localHarnessChecks().find((check) => check.id === id)
}

/**
 * Nothing is drawn until the first read comes back. The harness list is known
 * before it, so rows would appear at once and then rearrange as the accounts
 * and the machine logins land under them — a first frame the reader can act on
 * and that is not the answer.
 */
const ScanningNote: Component = () => {
  const language = useLanguage()
  return (
    <SettingsEmpty>
      <span class="flex items-center justify-center gap-2" data-component="agents-scanning">
        <Spinner class="size-4" />
        <span>{language.t("settings.providers.agents.scanning")}</span>
      </span>
    </SettingsEmpty>
  )
}

/** When this machine was last asked, and the way to ask it again. */
export const MachineScanStatus: Component = () => {
  const language = useLanguage()
  const machine = useMachineAccounts()
  return (
    <p class="flex items-center gap-1.5 text-12-regular text-text-weak">
      <span data-component="agents-scanned-at">{machine.scannedLabel()}</span>
      <Show when={!machine.scanning()}>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          class="border-none bg-transparent p-0 text-12-regular text-text-interactive-base"
          data-action="settings-providers-rescan"
          onClick={() => void machine.scan()}
        >
          {language.t("settings.providers.agents.rescan")}
        </button>
      </Show>
    </p>
  )
}

/** One harness's logins on this machine: its stored accounts, then the CLI's own. */
export const AgentHarnessAccounts: Component<{
  harness: LocalHarnessCheck
  /** Where the surrounding surface already names the harness and draws the action. */
  headerless?: boolean
  onAddAccountRef?: (open: () => void) => void
}> = (props) => {
  const machine = useMachineAccounts()
  return (
    <Show when={machine.opened()} fallback={<ScanningNote />}>
      <SettingsList>
        <AgentHarnessRow
          {...(props.headerless ? { headerless: true } : {})}
          {...(props.onAddAccountRef ? { onAddAccountRef: props.onAddAccountRef } : {})}
          id={harnessIcon(props.harness.id)}
          name={props.harness.label}
          providerId={props.harness.connectProvider}
          harness={props.harness.id}
          accounts={machine.listedAccounts(props.harness)}
          onSelect={(account) => machine.select(props.harness, account)}
          selecting={machine.selecting()}
          onCheck={(account) => machine.check(props.harness, account)}
          checking={machine.checking()}
          onRemove={(ids) => machine.remove(ids)}
          removing={machine.removing()}
          onConnected={() => machine.scan()}
        />
      </SettingsList>
    </Show>
  )
}
