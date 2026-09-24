import { Spinner } from "@/ui"
import { Show } from "solid-js"
import { formatRelativeTime } from "@/lib/relative-time"
import { useI18n } from "@/i18n"
import { SettingsEmpty, SettingsList } from "@/settings"
import { useAccountsText } from "../i18n"
import type { AccountsSnapshot, Harness } from "../model"
import type { Accounts } from "../store"
import { AgentHarnessRow } from "./harness-row"

const UNREAD: AccountsSnapshot = { stored: [], effective: undefined, machineLogins: [], scannedAt: 0 }

function ScanningNote() {
  const t = useAccountsText()
  return (
    <SettingsEmpty>
      <span class="flex items-center justify-center gap-2" data-component="agents-scanning">
        <Spinner class="size-4" />
        <span>{t("settings.providers.agents.scanning")}</span>
      </span>
    </SettingsEmpty>
  )
}

function useScannedLabel(accounts: Accounts) {
  const t = useAccountsText()
  const i18n = useI18n()
  return () => {
    const load = accounts.load()
    if (!accounts.opened()) return t("settings.providers.agents.scanning")
    if (accounts.scanning()) return t("settings.providers.agents.rescanning")
    if (load.kind !== "ready") return t("settings.providers.agents.scanFailed")
    const at = load.snapshot.scannedAt
    return Date.now() - at < 60_000 ? t("settings.providers.agents.scannedNow") : t("settings.providers.agents.scannedAt", { when: formatRelativeTime(at, i18n.intlTag()) })
  }
}

export function MachineScanStatus(props: { readonly accounts: Accounts }) {
  const t = useAccountsText()
  const label = useScannedLabel(props.accounts)
  return (
    <p class="flex items-center gap-1.5 text-12-regular text-text-weak">
      <span data-component="agents-scanned-at">{label()}</span>
      <Show when={!props.accounts.scanning()}>
        <span aria-hidden="true">·</span>
        <button type="button" class="border-none bg-transparent p-0 text-12-regular text-text-interactive-base" data-action="settings-providers-rescan" onClick={() => void props.accounts.rescan()}>
          {t("settings.providers.agents.rescan")}
        </button>
      </Show>
    </p>
  )
}

export function AgentHarnessAccounts(props: { readonly harness: Harness; readonly accounts: Accounts; readonly headerless?: boolean; readonly onAddAccountRef?: (open: () => void) => void }) {
  const snapshot = (): AccountsSnapshot | undefined => {
    const load = props.accounts.load()
    if (load.kind === "ready") return load.snapshot
    return load.kind === "failed" ? UNREAD : undefined
  }
  return (
    <Show when={snapshot()} fallback={<ScanningNote />}>
      {(current) => (
        <SettingsList>
          <AgentHarnessRow
            harness={props.harness}
            snapshot={current()}
            accounts={props.accounts}
            {...(props.headerless ? { headerless: true } : {})}
            {...(props.onAddAccountRef ? { onAddAccountRef: props.onAddAccountRef } : {})}
          />
        </SettingsList>
      )}
    </Show>
  )
}
