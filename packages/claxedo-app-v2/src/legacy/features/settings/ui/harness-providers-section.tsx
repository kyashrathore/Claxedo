import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import { createEffect, createMemo, createSignal, For, onMount, Show, type Component } from "solid-js"
import { DialogCustomProvider, useProviders } from "@/features/settings/app-ports"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"
import {
  canDisconnectProvider,
  disconnectProvider,
  providerSourceTagKey,
  removeProviderAuthEntry,
  type ProviderSource,
} from "@/features/settings/provider-settings-logic"
import { SettingsEmpty, SettingsList } from "@/ui/controls/settings-list"
import { ProviderSetupRow } from "@/features/settings/ui/provider-setup-row"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { useLanguage } from "@/platform/i18n/provider"
import { harnessDisplayLabel } from "@/platform/identity/harness-catalog"
import type { NativeHarnessId } from "@/platform/identity/harness-selection"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"
import { settingsCatalogProviders } from "@/features/settings/ui/settings-catalog-rules"
import { queryClient } from "@/platform/query/query-client"

type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

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
  /** Omitted where the surrounding section already names the harness. */
  titleKey?: string
  descriptionKey?: string
  /** Hands the custom-provider opener out, so a surface can draw it in its own header. */
  onAddCustomRef?: (open: () => void) => void
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

  const rows = createMemo(() =>
    settingsCatalogProviders({
      all: providerItems(),
      connectedIds: providerList().connected,
      popularProviders,
      query: search(),
    }))

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
  onMount(() => {
    if (props.harness === "opencode") props.onAddCustomRef?.(addCustomProvider)
  })

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
      <Show when={props.titleKey || props.descriptionKey}>
        <div class="flex flex-col gap-1">
          <Show when={props.titleKey}>
            {(key) => <h3 class="text-14-medium text-text-strong">{language.t(key())}</h3>}
          </Show>
          <Show when={props.descriptionKey}>
            {(key) => <p class="text-12-regular text-text-weak">{language.t(key())}</p>}
          </Show>
        </div>
      </Show>

      <Show when={providers.error()}>
        {(message) => (
          <SettingsEmpty>
            <span data-component={`${props.harness}-catalog-error`}>
              {language.t("settings.providers.catalog.error", {
                harness: harnessLabel(),
                workspace: workspaceLabel(),
                reason: message(),
              })}
            </span>
          </SettingsEmpty>
        )}
      </Show>

      <Show when={!providers.error() && !providers.loading() && providerItems().length === 0}>
        <SettingsEmpty>
          <span data-component={`${props.harness}-catalog-empty`}>
            {language.t("settings.providers.catalog.empty", {
              harness: harnessLabel(),
              workspace: workspaceLabel(),
            })}
          </span>
        </SettingsEmpty>
      </Show>

      {/* Always searchable. The threshold decides whether the unsearched view
          is a SUBSET, not whether a list is worth searching: Pi's seven rows
          and OpenCode's two hundred are both faster to type than to scan. */}
      <Show when={providerItems().length > 1}>
        {/* The same control the models list uses: a labelled, bordered field
            beside an unlabelled one read as two different kinds of search. */}
        <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
          <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
          <TextField
            variant="ghost"
            type="text"
            value={search()}
            onChange={setSearch}
            placeholder={language.t("settings.providers.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            class="flex-1"
            data-action="settings-providers-search"
          />
          <Show when={search()}>
            <IconButton icon="circle-x" variant="ghost" onClick={() => setSearch("")} />
          </Show>
        </div>
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
