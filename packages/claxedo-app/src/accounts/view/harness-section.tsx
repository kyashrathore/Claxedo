import { ProviderIcon } from "@/ui"
import { createMemo, createSignal, For, Match, Show, Switch, type JSX } from "solid-js"
import { createProviderCatalog, useModelVisibility } from "@/composer"
import type { HarnessSelection } from "@/lib/harness-selection"
import { SettingsEmpty, SettingsListSkeleton } from "@/settings"
import { useServer } from "@/server"
import { useAccountsText } from "../i18n"
import { useModelSource, groupContext, modelKeyOf, type SettingsPlacement } from "../model-sources"
import { harnessHasAccount, type Harness } from "../model"
import type { Accounts } from "../store"
import { AgentHarnessAccounts } from "./harness-accounts"
import { createHarnessProviders, HarnessProvidersSection } from "./harness-providers"
import { enabledCount, ModelsTab, soleSelfGroup } from "./models-tab"

export type HarnessTab = "accounts" | "models"

export type ModelsHarness = { readonly slug: string; readonly label: string; readonly selection: HarnessSelection; readonly kind: "cli" | "catalog" | "connection"; readonly cli?: Harness }

const TABS: readonly HarnessTab[] = ["accounts", "models"]

const LINK = "rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"

function HarnessTabs(props: { readonly tab: HarnessTab; readonly onTab: (tab: HarnessTab) => void; readonly actions: JSX.Element }) {
  const t = useAccountsText()
  return (
    <div class="flex items-center gap-1" role="tablist">
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
          <span>{t("settings.models.accounts.connection", { harness: props.harness.label })}</span>
        </SettingsEmpty>
      </Match>
    </Switch>
  )
}

function HarnessModels(props: { readonly harness: ModelsHarness; readonly placement: SettingsPlacement }) {
  const t = useAccountsText()
  const visibility = useModelVisibility()
  const source = useModelSource(props.harness.selection, () => props.placement)
  const count = createMemo(() => enabledCount(source(), (item, group) => visibility.visible(modelKeyOf(item), groupContext(group, item))))
  return (
    <>
      <div class="flex items-center justify-between gap-4">
        <span class="text-12-regular text-text-weak tabular-nums">{t("settings.models.enabled.count", { count: String(count()) })}</span>
        <Show when={soleSelfGroup(source(), props.harness.slug)}>
          {(group) => (
            <button type="button" class={LINK} data-action="settings-models-group-toggle-all" onClick={() => visibility.setGroupVisibility(group().groupKey, count() === 0, group().items.map(modelKeyOf))}>
              {t(count() === 0 ? "settings.models.group.enableAll" : "settings.models.group.disableAll")}
            </button>
          )}
        </Show>
      </div>
      <ModelsTab source={source()} harness={props.harness.slug} harnessLabel={props.harness.label} workspace={props.placement.label} />
    </>
  )
}

function accountless(harness: ModelsHarness, accounts: Accounts): boolean {
  const load = accounts.load()
  return harness.cli !== undefined && load.kind === "ready" && !harnessHasAccount(harness.cli, load.snapshot)
}

function HarnessTitle(props: { readonly harness: ModelsHarness; readonly actions?: JSX.Element }) {
  return (
    <div class="flex items-center gap-2">
      <ProviderIcon id={props.harness.slug} class="size-4 shrink-0 icon-strong-base" />
      <h2 class="text-14-medium text-text-strong">{props.harness.label}</h2>
      <span class="flex-1" />
      {props.actions}
    </div>
  )
}

function AddAccountAction(props: { readonly slug: string; readonly open: (() => void) | undefined }) {
  const t = useAccountsText()
  return (
    <Show when={props.open}>
      {(open) => (
        <button type="button" class={LINK} data-action="agent-add-account" onClick={() => open()()}>
          {props.slug === "opencode" ? t("provider.custom.title") : t("settings.providers.agents.addAccount")}
        </button>
      )}
    </Show>
  )
}

type SectionProps = { readonly harness: ModelsHarness; readonly accounts: Accounts; readonly placement?: SettingsPlacement; readonly tab: HarnessTab; readonly onTab: (tab: HarnessTab) => void }

function CatalogHarnessSection(props: SectionProps) {
  const server = useServer()
  const catalog = createProviderCatalog({ server, harness: () => props.harness.slug, eager: true })
  const [addAccount, setAddAccount] = createSignal<() => void>()
  return (
    <Switch
      fallback={
        <section class="flex flex-col gap-2" data-harness-accountless={props.harness.slug}>
          <HarnessTitle harness={props.harness} actions={<AddAccountAction slug={props.harness.slug} open={addAccount()} />} />
          <CatalogAccounts harness={props.harness.slug} onAddCustomRef={(open) => setAddAccount(() => open)} />
        </section>
      }
    >
      <Match when={!catalog.resolved()}>
        <section class="flex flex-col gap-2">
          <HarnessTitle harness={props.harness} />
          <SettingsListSkeleton />
        </section>
      </Match>
      <Match when={catalog.connected().length > 0}>
        <HarnessWithTabs {...props} />
      </Match>
    </Switch>
  )
}

export function HarnessSection(props: SectionProps) {
  return (
    <Switch fallback={<HarnessWithTabs {...props} />}>
      <Match when={accountless(props.harness, props.accounts) && props.harness.cli}>
        {(cli) => (
          <section class="flex flex-col gap-2" data-harness-accountless={props.harness.slug}>
            <HarnessTitle harness={props.harness} />
            <AgentHarnessAccounts harness={cli()} accounts={props.accounts} headerless />
          </section>
        )}
      </Match>
      <Match when={props.harness.kind === "catalog"}>
        <CatalogHarnessSection {...props} />
      </Match>
    </Switch>
  )
}

function HarnessWithTabs(props: SectionProps) {
  const t = useAccountsText()
  const [addAccount, setAddAccount] = createSignal<() => void>()
  const actions = <Show when={props.tab === "accounts"}><AddAccountAction slug={props.harness.slug} open={addAccount()} /></Show>
  return (
    <section class="flex flex-col gap-4">
      <HarnessTitle harness={props.harness} />
      <div class="flex flex-col gap-4">
        <HarnessTabs tab={props.tab} onTab={props.onTab} actions={actions} />
        <Show when={props.tab === "models"} fallback={<AccountsTab harness={props.harness} accounts={props.accounts} onAddRef={(open) => setAddAccount(() => open)} />}>
          <Show when={props.placement} fallback={<SettingsEmpty><span>{t("settings.models.workspace.required")}</span></SettingsEmpty>}>
            {(placement) => <HarnessModels harness={props.harness} placement={placement()} />}
          </Show>
        </Show>
      </div>
    </section>
  )
}
