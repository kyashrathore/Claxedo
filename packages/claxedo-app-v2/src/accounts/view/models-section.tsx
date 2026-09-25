import { createMemo, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createHarnessConnectionsCatalog } from "@/composer"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import { connectionHarness, NATIVE_HARNESS_IDS, nativeHarness } from "@/lib/harness-selection"
import { useServer } from "@/server"
import { SettingsIntro } from "@/settings"
import type { SettingsSection } from "@/shell"
import { useAccountsText } from "../i18n"
import { harnesses } from "../model"
import { useSettingsScope } from "../model-sources"
import { useAccounts } from "../store"
import { MachineScanStatus } from "./harness-accounts"
import { HarnessSection, type HarnessTab, type ModelsHarness } from "./harness-section"

const NATIVE: readonly ModelsHarness[] = NATIVE_HARNESS_IDS.map((id) => {
  const cli = harnesses.find((harness) => harness.id === id)
  return { slug: id, label: harnessDisplayLabel(id), selection: nativeHarness(id), kind: cli ? "cli" : "catalog", ...(cli ? { cli } : {}) }
})

function useModelsHarnesses() {
  const server = useServer()
  const connections = createHarnessConnectionsCatalog({ api: server.harnessConfig })
  onMount(() => void connections.refresh())
  return createMemo((): readonly ModelsHarness[] => {
    const catalog = connections.data()
    const enabled = catalog?.status === "supported" ? catalog.connections.filter((row) => row.enabled) : []
    return [...NATIVE, ...enabled.map((row): ModelsHarness => ({ slug: `connection:${row.connectionId}`, label: row.label, selection: connectionHarness(row.connectionId), kind: "connection" }))]
  })
}

function ModelsSection() {
  const t = useAccountsText()
  const accounts = useAccounts()
  const scope = useSettingsScope()
  const list = useModelsHarnesses()
  const [tabs, setTabs] = createStore<Record<string, HarnessTab>>({})
  return (
    <div class="settings-body">
      <SettingsIntro description={t("settings.models.description")} />
      <MachineScanStatus accounts={accounts} />
      <Show
        when={scope().placement}
        fallback={<p class="text-12-regular text-text-weak">{scope().loading ? t("settings.scope.workspace.loading") : t("settings.scope.workspace.empty")}</p>}
      >
        {(placement) => (
          <div class="flex flex-col gap-10">
            <For each={list()}>
              {(harness) => <HarnessSection harness={harness} accounts={accounts} placement={placement()} tab={tabs[harness.slug] ?? "accounts"} onTab={(tab) => setTabs(harness.slug, tab)} />}
            </For>
          </div>
        )}
      </Show>
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
