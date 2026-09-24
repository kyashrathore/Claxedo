import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { ProviderIcon, RadioGroup } from "@/ui"
import { Button } from "@opencode-ai/ui/button"
import { useTranslator } from "@/i18n"
import { formatRelativeTime } from "@/lib/relative-time"
import { harnessAccounts, harnesses, harnessRunnable, machineLoginOf, selectedAccountKey, type AccountsSnapshot, type Harness } from "../accounts"
import { useWindowName } from "@/usage"
import { dictionary } from "../i18n"
import { useAccounts, type Accounts } from "../store"
import { machineLoginWords, storedAccountWords } from "./account-words"
import { AccountRow } from "./account-row"
import { AddKeyForm } from "./add-key"
import { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsNote } from "./section"

const HARNESS_ICON: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai", cursor: "cursor" }

export function AccountsSection() {
  const t = useTranslator(dictionary)
  const accounts = useAccounts()
  const snapshot = (): AccountsSnapshot | undefined => {
    const load = accounts.load()
    return load.kind === "ready" ? load.snapshot : undefined
  }
  const loadError = () => {
    const load = accounts.load()
    if (load.kind === "failed") return load.error
    return load.kind === "ready" ? load.refreshError : undefined
  }
  const scanLabel = () => {
    const current = snapshot()
    if (accounts.scanning()) return t(current ? "settings.accounts.rescanning" : "settings.accounts.scanning")
    if (!current) return t(accounts.load().kind === "failed" ? "settings.accounts.scanFailed" : "settings.accounts.scanning")
    const age = Date.now() - current.scannedAt
    return age < 60_000 ? t("settings.accounts.scannedNow") : t("settings.accounts.scannedAt", { when: formatRelativeTime(current.scannedAt) })
  }

  return (
    <div class="settings-body" data-component="settings-accounts">
      <SettingsIntro
        description={t("settings.accounts.description")}
        action={
          <span class="settings-inline">
            <span class="settings-row-description">{scanLabel()}</span>
            <Show when={!accounts.scanning()}>
              <span aria-hidden="true">·</span>
              <button type="button" class="border-none bg-transparent p-0 text-12-regular text-text-interactive-base" onClick={() => accounts.rescan()}>
                {t("settings.accounts.rescan")}
              </button>
            </Show>
          </span>
        }
      />
      <Show when={loadError()}>{(error) => <SettingsNote tone="danger">{t("settings.accounts.failed")}: {error().message}</SettingsNote>}</Show>
      <Show when={accounts.failure()}>{(failure) => <SettingsNote tone="danger">{t("settings.accounts.actionFailed")}: {failure().error.message}</SettingsNote>}</Show>
      <Show when={snapshot()} fallback={<SettingsEmpty>{scanLabel()}</SettingsEmpty>}>
        {(current) => <For each={harnesses}>{(harness) => <HarnessCard harness={harness} snapshot={current()} accounts={accounts} />}</For>}
      </Show>
    </div>
  )
}

export function HarnessAccountCards(props: { readonly scanning: JSX.Element; readonly onReady: (ready: boolean) => void }) {
  const accounts = useAccounts()
  const snapshot = (): AccountsSnapshot | undefined => {
    const load = accounts.load()
    return load.kind === "ready" ? load.snapshot : undefined
  }
  createEffect(() => {
    const current = snapshot()
    props.onReady(current !== undefined && harnesses.some((harness) => harnessRunnable(harness, current, accounts.liveChecks())))
  })
  return (
    <Show when={snapshot()} fallback={props.scanning}>
      {(current) => (
        <div class="flex flex-col gap-6">
          <For each={harnesses}>{(harness) => <HarnessCard harness={harness} snapshot={current()} accounts={accounts} />}</For>
        </div>
      )}
    </Show>
  )
}

function HarnessCard(props: { readonly harness: Harness; readonly snapshot: AccountsSnapshot; readonly accounts: Accounts }) {
  const t = useTranslator(dictionary)
  const [adding, setAdding] = createSignal(false)
  const selected = createMemo(() => selectedAccountKey(props.harness, props.snapshot))
  const windowName = useWindowName()
  const rows = createMemo(() => {
    const stored = harnessAccounts(props.harness, props.snapshot.stored).map((row) => storedAccountWords({ t, windowName }, row, props.accounts.liveChecks()[row.id]))
    const login = machineLoginOf(props.harness, props.snapshot)
    return login ? [...stored, machineLoginWords({ t, windowName }, login, props.harness, props.snapshot)] : stored
  })
  const connecting = () => props.accounts.activity()?.kind === "connecting" && props.accounts.activity()?.key === props.harness.id

  return (
    <SettingsGroup
      title={props.harness.label}
      action={
        <Button size="large" variant="ghost" data-action="agent-add-account" aria-expanded={adding()} onClick={() => setAdding(!adding())}>
          {t("settings.accounts.addKey")}
        </Button>
      }
    >
      <SettingsList>
        <div class="settings-inline" style={{ padding: "8px 0" }}>
          <ProviderIcon id={HARNESS_ICON[props.harness.id] ?? props.harness.id} />
          <span class="settings-row-description">{props.harness.vendor}</span>
        </div>
        <Show when={adding()}>
          <AddKeyForm harness={props.harness} busy={connecting()} onSave={(label, secret) => props.accounts.addKey(props.harness, label, secret)} onCancel={() => setAdding(false)} />
        </Show>
        <RadioGroup
          aria-label={props.harness.label}
          hideLabel
          value={selected()}
          disabled={props.accounts.activity()?.kind === "selecting"}
          onChange={(key: string) => {
            const row = rows().find((entry) => entry.key === key)
            if (row) props.accounts.select(props.harness, key, row.ids)
          }}
        >
          <For each={rows()}>
            {(row) => (
              <AccountRow
                account={row}
                activity={props.accounts.activity()}
                onCheck={() => (row.machine ? props.accounts.checkMachine(props.harness) : props.accounts.check(row.ids[0] ?? row.key))}
                onRemove={() => props.accounts.remove(row.ids)}
              />
            )}
          </For>
        </RadioGroup>
      </SettingsList>
    </SettingsGroup>
  )
}
