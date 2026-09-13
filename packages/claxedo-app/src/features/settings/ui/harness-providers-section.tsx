import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { DialogCustomProvider, useProviders } from "@/features/settings/app-ports"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"
import {
  canDisconnectProvider,
  disconnectProvider,
  providerSourceTagKey,
  removeProviderAuthEntry,
  type ProviderSource,
} from "@/features/settings/provider-settings-logic"
import { SettingsList } from "@/features/settings/ui/list"
import { ProviderSetupRow } from "@/features/settings/ui/provider-setup-row"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { useLanguage } from "@/platform/i18n/provider"
import { harnessDisplayLabel } from "@/ui/harness-display"
import type { NativeHarnessId } from "@/platform/identity/harness-selection"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"
import { queryClient } from "@/platform/query/query-client"

type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

/**
 * Above this size a catalog is the models.dev registry (~179 entries) rather
 * than a harness's own binding set, and the unsearched page shows the popular
 * and connected rows instead of all of it.
 */
const FULL_CATALOG_LIMIT = 24

const PROVIDER_NOTES = [
  { match: (id: string) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id: string) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

/**
 * One catalog harness's providers, for the workspace Settings is scoped to.
 *
 * The catalog, the credentials behind it and the auth entry a disconnect drops
 * all belong to (this harness, that workspace), so every read and write here
 * carries the pair.
 */
export const HarnessProvidersSection: Component<{
  harness: NativeHarnessId
  titleKey: string
  descriptionKey?: string
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const scope = useSettingsScope()
  const providers = useProviders(() => props.harness, scope.scopeRef)
  const providerList = createMemo(() => providers.state())
  const providerItems = createMemo(() => Array.from(providerList().all.values()))
  const [search, setSearch] = createSignal("")

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return undefined
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return undefined
  }

  createEffect(() => {
    const ids = providerList().connected.filter((id) => {
      const provider = providerList().all.get(id)
      return provider && source(provider) === undefined
    })
    if (ids.length === 0) return
    // Hydrate connected rows in the background; some env-only providers are listed
    // as connected but have no runtime catalog entry.
    void Promise.allSettled(ids.map((id) => providers.load(id)))
  })

  const rows = createMemo(() => {
    const query = search().trim().toLowerCase()
    const connected = new Set(providerList().connected)
    const items = providerItems()
    return items
      .filter((item) => {
        if (query) {
          return item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query)
        }
        if (items.length <= FULL_CATALOG_LIMIT) return true
        return popularProviders.includes(item.id) || connected.has(item.id)
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const type = (item: ProviderItem) => language.t(providerSourceTagKey(source(item)))
  const canDisconnect = (item: ProviderItem) => canDisconnectProvider(source(item))
  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key
  const connectedIds = createMemo(() => new Set(providerList().connected))
  const harnessLabel = () => harnessDisplayLabel(props.harness)
  const workspaceLabel = () => scope.workspace()?.label ?? ""

  const markDisconnected = (providerID: string) => {
    queryClient.setQueryData<NormalizedProviderListResponse | undefined>(providers.queryKey(), (cached) => {
      if (!cached) return cached
      return { ...cached, connected: cached.connected.filter((item) => item !== providerID) }
    })
  }

  const addCustomProvider = () => {
    void dialog.show(() => <DialogCustomProvider scope={scope.scopeRef()} />)
  }

  const disconnect = async (item: ProviderItem) => {
    await disconnectProvider({
      providerId: item.id,
      name: item.name,
      source: source(item),
      deleteCredential: async (id) => {
        await claxedoCredentialRequest({ providerId: id }, { method: "DELETE" })
      },
      removeAuth: async (id) => {
        await removeProviderAuthEntry({
          serverUrl: getClaxedoServerUrl(),
          providerId: id,
          harness: props.harness,
          directory: scope.scopeRef(),
          request: authFetch,
        })
      },
      markDisconnected,
      refresh: async () => {
        await providers.refresh()
      },
      onSuccess: (providerName) => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: providerName }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: providerName }),
        })
      },
      onError: (message) => {
        showToast({ title: language.t("common.requestFailed"), description: message })
      },
    })
  }

  return (
    <div class="flex flex-col gap-3" data-component={`${props.harness}-providers-section`}>
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong">{language.t(props.titleKey)}</h3>
          <Show when={props.descriptionKey}>
            {(key) => <p class="text-12-regular text-text-weak">{language.t(key())}</p>}
          </Show>
        </div>
        <Show when={props.harness === "opencode"}>
          <Button
            size="small"
            variant="ghost"
            data-action="settings-providers-add-custom"
            onClick={addCustomProvider}
          >
            {language.t("provider.custom.title")}
          </Button>
        </Show>
      </div>

      <Show when={providers.error()}>
        {(message) => (
          <p class="text-12-regular text-text-weak" data-component={`${props.harness}-catalog-error`}>
            {language.t("settings.providers.catalog.error", {
              harness: harnessLabel(),
              workspace: workspaceLabel(),
              reason: message(),
            })}
          </p>
        )}
      </Show>

      <Show when={!providers.error() && !providers.loading() && providerItems().length === 0}>
        <p class="text-12-regular text-text-weak" data-component={`${props.harness}-catalog-empty`}>
          {language.t("settings.providers.catalog.empty", {
            harness: harnessLabel(),
            workspace: workspaceLabel(),
          })}
        </p>
      </Show>

      <Show when={providerItems().length > FULL_CATALOG_LIMIT}>
        <TextField
          label={language.t("settings.providers.search.label")}
          placeholder={language.t("settings.providers.search.placeholder")}
          value={search()}
          onChange={setSearch}
        />
      </Show>

      <SettingsList>
        <For each={rows()}>
          {(item) => (
            <Show
              when={connectedIds().has(item.id)}
              fallback={(
                <ProviderSetupRow
                  id={item.id}
                  name={item.name}
                  providerId={item.id}
                  harness={props.harness}
                  scope={scope.scopeRef()}
                  note={note(item.id) ? language.t(note(item.id)!) : undefined}
                  onConnected={async () => { await providers.refresh() }}
                />
              )}
            >
              <div
                class="flex flex-wrap items-center justify-between gap-4 border-b border-border-weak-base py-3 last:border-none"
                data-provider={item.id}
              >
                <div class="flex min-w-0 items-center gap-3">
                  <ProviderIcon id={item.id} class="size-5 shrink-0 icon-strong-base" />
                  <div class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-14-medium text-text-strong">{item.name}</span>
                    <Show when={note(item.id)}>
                      {(key) => <span class="text-12-regular text-text-weak">{language.t(key())}</span>}
                    </Show>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Tag>{type(item)}</Tag>
                  <Show when={canDisconnect(item)}>
                    <Button size="large" variant="ghost" onClick={() => void disconnect(item)}>
                      {language.t("common.disconnect")}
                    </Button>
                  </Show>
                </div>
              </div>
            </Show>
          )}
        </For>
      </SettingsList>
    </div>
  )
}
