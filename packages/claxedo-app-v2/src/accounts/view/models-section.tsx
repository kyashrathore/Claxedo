import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { createSignal, For, Show } from "solid-js"
import { SettingsIntro } from "@/settings"
import type { SettingsSection } from "@/shell"
import { useAccountsText } from "../i18n"
import { harnesses, type Harness } from "../model"
import { useAccounts, type Accounts } from "../store"
import { AgentHarnessAccounts, MachineScanStatus } from "./harness-accounts"

function HarnessTabs(props: { readonly onAdd: (() => void) | undefined }) {
  const t = useAccountsText()
  return (
    <div class="flex items-center gap-1" role="tablist" data-component="models-harness-tabs">
      <button type="button" role="tab" aria-selected={true} class="rounded-md px-2.5 py-1 text-13-regular text-text-strong bg-surface-base" data-action="settings-models-tab-accounts">
        {t("settings.models.tab.accounts")}
      </button>
      <span class="flex-1" />
      <Show when={props.onAdd}>
        {(open) => (
          <button type="button" class="rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base" data-action="agent-add-account" onClick={() => open()()}>
            {t("settings.providers.agents.addAccount")}
          </button>
        )}
      </Show>
    </div>
  )
}

function HarnessSection(props: { readonly harness: Harness; readonly accounts: Accounts }) {
  const [addAccount, setAddAccount] = createSignal<() => void>()
  return (
    <section class="flex flex-col gap-4" data-component={`models-section-${props.harness.id}`}>
      <div class="flex items-baseline justify-between gap-4">
        <div class="flex items-center gap-2">
          <ProviderIcon id={props.harness.id} class="size-4 shrink-0 icon-strong-base" />
          <h2 class="text-14-medium text-text-strong">{props.harness.label}</h2>
        </div>
      </div>
      <div class="flex flex-col gap-4">
        <HarnessTabs onAdd={addAccount()} />
        <AgentHarnessAccounts harness={props.harness} accounts={props.accounts} headerless onAddAccountRef={(open) => setAddAccount(() => open)} />
      </div>
    </section>
  )
}

function ModelsSection() {
  const t = useAccountsText()
  const accounts = useAccounts()
  return (
    <div class="settings-body" data-component="settings-models-page">
      <SettingsIntro description={t("settings.models.description")} />
      <MachineScanStatus accounts={accounts} />
      <div class="flex flex-col gap-10">
        <For each={harnesses}>{(harness) => <HarnessSection harness={harness} accounts={accounts} />}</For>
      </div>
    </div>
  )
}

export const modelsSettingsSection: SettingsSection = {
  id: "models",
  title: () => useAccountsText()("settings.models.title"),
  group: "account",
  order: 35,
  view: ModelsSection,
}
