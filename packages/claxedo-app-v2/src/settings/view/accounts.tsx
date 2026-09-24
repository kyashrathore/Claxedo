import { createMemo, createSignal, For, Show } from "solid-js"
import { Button, ProviderIcon, RadioGroup } from "@/ui"
import { useTranslator } from "@/i18n"
import { formatRelativeTime } from "@/lib/relative-time"
import { harnessAccounts, harnesses, machineLoginOf, selectedAccountKey, type AccountsSnapshot, type Harness } from "../accounts"
import { dictionary } from "../i18n"
import { createAccounts, type Accounts } from "../store"
import { machineLoginWords, storedAccountWords } from "./account-words"
import { AccountRow } from "./account-row"
import { AddKeyForm } from "./add-key"
import { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsNote } from "./section"

const HARNESS_ICON: Readonly<Record<string, string>> = { claude: "anthropic", codex: "openai", cursor: "cursor" }

export function AccountsSection() {
  const t = useTranslator(dictionary)
  const accounts = createAccounts()
  const snapshot = (): AccountsSnapshot | undefined => {
    const state = accounts.state()
    if (state.kind === "ready") return state.snapshot
    if (state.kind === "scanning" || state.kind === "failed") return state.previous
    return undefined
  }
  const scanError = () => {
    const state = accounts.state()
    return state.kind === "failed" ? state.error : undefined
  }
  const scanLabel = () => {
    const state = accounts.state()
    if (state.kind === "idle" || (state.kind === "scanning" && !state.previous)) return t("settings.accounts.scanning")
    if (state.kind === "scanning") return t("settings.accounts.rescanning")
    if (state.kind === "failed") return t("settings.accounts.scanFailed")
    const age = Date.now() - state.snapshot.scannedAt
    return age < 60_000 ? t("settings.accounts.scannedNow") : t("settings.accounts.scannedAt", { when: formatRelativeTime(state.snapshot.scannedAt) })
  }

  return (
    <div class="settings-body" data-component="settings-accounts">
      <SettingsIntro
        description={t("settings.accounts.description")}
        action={
          <span class="settings-inline">
            <span class="settings-row-description" data-component="accounts-scanned-at">{scanLabel()}</span>
            <Button size="small" variant="ghost" disabled={accounts.state().kind === "scanning"} onClick={() => void accounts.scan({ fresh: true })}>
              {t("settings.accounts.rescan")}
            </Button>
          </span>
        }
      />
      <Show when={scanError()}>
        {(error) => <SettingsNote tone="danger">{t("settings.accounts.failed")}: {error().message}</SettingsNote>}
      </Show>
      <Show when={snapshot()} fallback={<SettingsEmpty>{scanLabel()}</SettingsEmpty>}>
        {(current) => <For each={harnesses}>{(harness) => <HarnessCard harness={harness} snapshot={current()} accounts={accounts} />}</For>}
      </Show>
    </div>
  )
}

function HarnessCard(props: { readonly harness: Harness; readonly snapshot: AccountsSnapshot; readonly accounts: Accounts }) {
  const t = useTranslator(dictionary)
  const [adding, setAdding] = createSignal(false)
  const selected = createMemo(() => selectedAccountKey(props.harness, props.snapshot))
  const rows = createMemo(() => {
    const stored = harnessAccounts(props.harness, props.snapshot.stored).map((row) =>
      storedAccountWords(t, row, props.accounts.liveChecks()[row.id], selected() === row.id),
    )
    const login = machineLoginOf(props.harness, props.snapshot)
    return login ? [...stored, machineLoginWords(t, login, props.harness, props.snapshot)] : stored
  })
  const connecting = () => props.accounts.activity()?.kind === "connecting" && props.accounts.activity()?.key === props.harness.id

  return (
    <SettingsGroup
      title={props.harness.label}
      action={
        <Button size="small" variant="ghost" data-action="agent-add-account" aria-expanded={adding()} onClick={() => setAdding(!adding())}>
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
            if (row) void props.accounts.select(props.harness, key, row.ids)
          }}
        >
          <For each={rows()}>
            {(row) => (
              <AccountRow
                account={row}
                activity={props.accounts.activity()}
                onCheck={() => void (row.machine ? props.accounts.checkMachine(props.harness) : props.accounts.check(row.ids[0] ?? row.key))}
                onRemove={() => void props.accounts.remove(row.ids)}
              />
            )}
          </For>
        </RadioGroup>
      </SettingsList>
    </SettingsGroup>
  )
}
