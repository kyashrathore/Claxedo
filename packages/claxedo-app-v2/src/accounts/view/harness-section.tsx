import { ProviderIcon } from "@/ui"
import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { useModelVisibility } from "@/composer"
import type { HarnessSelection } from "@/lib/harness-selection"
import { SettingsEmpty } from "@/settings"
import { useAccountsText } from "../i18n"
import { useModelSource, type SettingsPlacement } from "../model-sources"
import type { Harness } from "../model"
import type { Accounts } from "../store"
import { AgentHarnessAccounts } from "./harness-accounts"
import { createHarnessProviders, HarnessProvidersSection } from "./harness-providers"
import { enabledCount, groupContext, modelKeyOf, ModelsTab, soleSelfGroup } from "./models-tab"

export type HarnessTab = "accounts" | "models"

export type ModelsHarness = { readonly slug: string; readonly label: string; readonly selection: HarnessSelection; readonly kind: "cli" | "catalog" | "connection"; readonly cli?: Harness }

const TABS: readonly HarnessTab[] = ["accounts", "models"]

const LINK = "rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"

function HarnessTabs(props: { readonly tab: HarnessTab; readonly onTab: (tab: HarnessTab) => void; readonly actions: JSX.Element }) {
  const t = useAccountsText()
  return (
    <div class="flex items-center gap-1" role="tablist" data-component="models-harness-tabs">
      <For each={TABS}>
        {(value) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.tab === value}
            class="rounded-md px-2.5 py-1 text-13-regular"
            classList={{ "text-text-strong bg-surface-base": props.tab === value, "text-text-weak": props.tab !== value }}
            data-action={`settings-models-tab-${value}`}
            onClick={() => props.onTab(value)}
          >
            {t(value === "accounts" ? "settings.models.tab.accounts" : "settings.models.tab.models")}
          </button>
        )}
      </For>
      <span class="flex-1" />
      {props.actions}
    </div>
  )
}

function CatalogAccounts(props: { readonly harness: string; readonly onAddCustomRef: (open: () => void) => void }) {
  const providers = createHarnessProviders(() => props.harness)
  return <HarnessProvidersSection providers={providers} onAddCustomRef={props.onAddCustomRef} />
}

function AccountsTab(props: { readonly harness: ModelsHarness; readonly accounts: Accounts; readonly onAddRef: (open: () => void) => void }) {
  const t = useAccountsText()
  return (
    <Switch fallback={<CatalogAccounts harness={props.harness.slug} onAddCustomRef={props.onAddRef} />}>
      <Match when={props.harness.cli}>{(cli) => <AgentHarnessAccounts harness={cli()} accounts={props.accounts} headerless onAddAccountRef={props.onAddRef} />}</Match>
      <Match when={props.harness.kind === "connection"}>
        <SettingsEmpty>
          <span data-component="models-accounts-external">{t("settings.models.accounts.connection", { harness: props.harness.label })}</span>
        </SettingsEmpty>
      </Match>
    </Switch>
  )
}

export function HarnessSection(props: { readonly harness: ModelsHarness; readonly accounts: Accounts; readonly placement: SettingsPlacement; readonly tab: HarnessTab; readonly onTab: (tab: HarnessTab) => void }) {
  const t = useAccountsText()
  const visibility = useModelVisibility()
  const [addAccount, setAddAccount] = createSignal<() => void>()
  const source = useModelSource(props.harness.selection, () => props.placement)
  const count = createMemo(() => enabledCount(source(), (item, group) => visibility.visible(modelKeyOf(item), groupContext(group, item))))
  const sole = () => soleSelfGroup(source(), props.harness.slug)
  const actions = (
    <>
      <Show when={props.tab === "accounts" && addAccount()}>
        {(open) => (
          <button type="button" class={LINK} data-action="agent-add-account" onClick={() => open()()}>
            {props.harness.slug === "opencode" ? t("provider.custom.title") : t("settings.providers.agents.addAccount")}
          </button>
        )}
      </Show>
      <Show when={props.tab === "models" ? sole() : undefined}>
        {(group) => (
          <button type="button" class={LINK} data-action="settings-models-group-toggle-all" onClick={() => visibility.setGroupVisibility(group().groupKey, count() === 0, group().items.map(modelKeyOf))}>
            {t(count() === 0 ? "settings.models.group.enableAll" : "settings.models.group.disableAll")}
          </button>
        )}
      </Show>
    </>
  )
  return (
    <section class="flex flex-col gap-4" data-component={`models-section-${props.harness.slug}`}>
      <div class="flex items-baseline justify-between gap-4">
        <div class="flex items-center gap-2">
          <ProviderIcon id={props.harness.slug} class="size-4 shrink-0 icon-strong-base" />
          <h2 class="text-14-medium text-text-strong">{props.harness.label}</h2>
        </div>
        <span class="text-12-regular text-text-weak tabular-nums">{t("settings.models.enabled.count", { count: String(count()) })}</span>
      </div>
      <div class="flex flex-col gap-4">
        <HarnessTabs tab={props.tab} onTab={props.onTab} actions={actions} />
        <Show when={props.tab === "models"} fallback={<AccountsTab harness={props.harness} accounts={props.accounts} onAddRef={(open) => setAddAccount(() => open)} />}>
          <ModelsTab source={source()} harness={props.harness.slug} harnessLabel={props.harness.label} workspace={props.placement.label} />
        </Show>
      </div>
    </section>
  )
}
