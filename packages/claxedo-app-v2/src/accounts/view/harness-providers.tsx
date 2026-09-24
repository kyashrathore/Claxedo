import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { createProviderCatalog } from "@/composer"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import { SettingsEmpty, SettingsList } from "@/settings"
import { toAppError, useServer, type CatalogProvider } from "@/server"
import { ClaxedoIcon as Icon, ClaxedoIconButton as IconButton, showToast, useDialog, Button } from "@/ui"
import { canDisconnectProvider, catalogProviders, providerNote, providerSourceTag } from "../catalog-rules"
import { useAccountsText } from "../i18n"
import { DialogCustomProvider } from "./custom-provider-dialog"
import { ProviderSetupRow } from "./provider-setup-row"
import { SearchField } from "./search-field"

export function createHarnessProviders(harness: () => string) {
  const server = useServer()
  const catalog = createProviderCatalog({ server, harness })
  const detailed = new Set<string>()
  createEffect(() => {
    const unsourced = catalog.connected().filter((provider) => provider.source === undefined && !detailed.has(provider.id))
    for (const provider of unsourced) detailed.add(provider.id)
    if (unsourced.length > 0) void Promise.allSettled(unsourced.map((provider) => catalog.load(provider.id)))
  })
  const t = useAccountsText()
  const disconnect = async (provider: CatalogProvider) => {
    try {
      await server.providerConnect.disconnect(harness(), provider.id)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: t("provider.disconnect.toast.disconnected.title", { provider: provider.name }),
        description: t("provider.disconnect.toast.disconnected.description", { provider: provider.name }),
      })
      await catalog.refresh()
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
    }
  }
  return { harness, catalog, disconnect, connected: () => catalog.connected().length > 0, machine: () => server.capabilities()?.thisMachine?.name ?? "" }
}

function ConnectedProvider(props: { readonly provider: CatalogProvider; readonly onDisconnect: () => void }) {
  const t = useAccountsText()
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 border-b border-border-weak-base py-3 last:border-none" data-provider={props.provider.id}>
      <div class="flex min-w-0 items-center gap-3">
        <ProviderIcon id={props.provider.id} class="size-5 shrink-0 icon-strong-base" />
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-14-medium text-text-strong">{props.provider.name}</span>
          <Show when={providerNote(props.provider.id)}>{(key) => <span class="text-12-regular text-text-weak">{t(key())}</span>}</Show>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Tag>{t(providerSourceTag(props.provider.source))}</Tag>
        <Show when={canDisconnectProvider(props.provider.source)}>
          <Button size="large" variant="ghost" onClick={() => props.onDisconnect()}>
            {t("common.disconnect")}
          </Button>
        </Show>
      </div>
    </div>
  )
}

function CatalogNote(props: { readonly harness: string; readonly machine: string; readonly error: string | undefined }) {
  const t = useAccountsText()
  const vars = () => ({ harness: harnessDisplayLabel(props.harness), workspace: props.machine })
  return (
    <SettingsEmpty>
      <Show when={props.error} fallback={<span data-component={`${props.harness}-catalog-empty`}>{t("settings.providers.catalog.empty", vars())}</span>}>
        {(reason) => <span data-component={`${props.harness}-catalog-error`}>{t("settings.providers.catalog.error", { ...vars(), reason: reason() })}</span>}
      </Show>
    </SettingsEmpty>
  )
}

export type HarnessProviders = ReturnType<typeof createHarnessProviders>

export function HarnessProvidersSection(props: { readonly providers: HarnessProviders; readonly onAddCustomRef?: (open: () => void) => void }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const harness = () => props.providers.harness()
  const catalog = () => props.providers.catalog
  onMount(() => {
    if (harness() !== "opencode") return
    props.onAddCustomRef?.(() => void dialog.show(() => <DialogCustomProvider existing={new Set(catalog().all().keys())} onSaved={() => catalog().refresh()} />))
  })
  const [search, setSearch] = createSignal("")
  const items = createMemo(() => [...catalog().all().values()])
  const connectedIds = createMemo(() => new Set(catalog().connected().map((provider) => provider.id)))
  const rows = createMemo(() => catalogProviders(items(), [...connectedIds()], search()))
  const note = (id: string) => {
    const key = providerNote(id)
    return key ? t(key) : undefined
  }
  return (
    <div class="flex flex-col gap-3" data-component={`${harness()}-providers-section`}>
      <Show when={catalog().error() || (!catalog().loading() && catalog().resolved() && items().length === 0)}>
        <CatalogNote harness={harness()} machine={props.providers.machine()} error={catalog().error()} />
      </Show>
      <Show when={items().length > 1}>
        <SearchField value={search()} onChange={setSearch} placeholder={t("settings.providers.search.placeholder")} action="settings-providers-search" />
      </Show>
      <SettingsList>
        <For each={rows()}>
          {(item) => (
            <Show
              when={connectedIds().has(item.id)}
              fallback={
                <ProviderSetupRow id={item.id} name={item.name} harness={harness()} note={note(item.id)} onConnected={() => catalog().refresh()} />
              }
            >
              <ConnectedProvider provider={item} onDisconnect={() => void props.providers.disconnect(item)} />
            </Show>
          )}
        </For>
      </SettingsList>
    </div>
  )
}
