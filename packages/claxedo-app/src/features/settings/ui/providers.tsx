// Claxedo adds mobile settings navigation and Claxedo-owned terminal and sandbox tabs.
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogCustomProvider, useProviders } from "@/features/settings/app-ports"
import { createEffect, createMemo, createSignal, type Component, For, Show } from "solid-js"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"
import { SettingsList } from "@/features/settings/ui/list"
import { useLanguage } from "@/platform/i18n/provider"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { queryClient } from "@/platform/query/query-client"
import {
  canDisconnectProvider,
  disconnectProvider,
  providerSourceTagKey,
  removeProviderAuthEntry,
  setProviderDisabled,
} from "@/features/settings/provider-settings-logic"
import { ProviderSetupRow } from "@/features/settings/ui/provider-setup-row"
import { SettingsScopeSelector } from "@/features/settings/ui/scope-selector"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"

type ProviderSource = "env" | "api" | "config" | "custom"
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

export const SettingsProviders: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  // The one question this surface answers: which harness, on which machine.
  // Both come from the explicit selection above the list, never from a default.
  const scope = useSettingsScope()
  const providers = useProviders(scope.harness, scope.scopeRef)
  const providerList = createMemo(() => providers.state())
  const providerItems = createMemo(() => Array.from(providerList().all.values()))

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const [search, setSearch] = createSignal("")

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
  // Custom providers are entries in the OpenCode provider registry; no other
  // harness reads one.
  const showCustom = () => scope.harness() === "opencode"
  const connectedIds = createMemo(() => new Set(providerList().connected))
  const harnessLabel = () => scope.harnesses().find((item) => item.id === scope.harness())?.label ?? scope.harness()
  const workspaceLabel = () => scope.workspace()?.label ?? ""

  const markDisconnected = (providerID: string) => {
    const patch = (cached: NormalizedProviderListResponse | undefined) => {
      if (!cached) return cached
      return {
        ...cached,
        connected: cached.connected.filter((item) => item !== providerID),
      }
    }
    queryClient.setQueryData<NormalizedProviderListResponse | undefined>(providers.queryKey(), patch)
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
          harness: scope.harness(),
          directory: scope.scopeRef(),
          request: authFetch,
        })
      },
      disableInConfig: async (id) => {
        await setProviderDisabled({
          serverUrl: getClaxedoServerUrl(),
          providerId: id,
          harness: scope.harness(),
          directory: scope.scopeRef(),
          disabled: true,
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
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-4 pt-6 pb-8 max-w-[720px]">
        <div class="flex flex-col gap-1">
          <h2 class="text-18-medium text-text-strong">{language.t("settings.providers.title")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.providers.description")}</p>
        </div>
        <SettingsScopeSelector />
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show
          when={scope.workspace()}
          fallback={(
            <p class="text-12-regular text-text-weak" data-component="providers-no-workspace">
              {scope.loading()
                ? language.t("settings.scope.workspace.loading")
                : language.t("settings.scope.workspace.empty")}
            </p>
          )}
        >
          <Show when={providers.error()}>
            {(message) => (
              <p class="text-12-regular text-text-weak" data-component="providers-catalog-error">
                {language.t("settings.providers.catalog.error", {
                  harness: harnessLabel(),
                  workspace: workspaceLabel(),
                  reason: message(),
                })}
              </p>
            )}
          </Show>

          <Show when={!providers.error() && !providers.loading() && providerItems().length === 0}>
            <p class="text-12-regular text-text-weak" data-component="providers-catalog-empty">
              {language.t("settings.providers.catalog.empty", {
                harness: harnessLabel(),
                workspace: workspaceLabel(),
              })}
            </p>
          </Show>

          {/* The custom-provider entry ADDS a provider to the OpenCode
              registry, so it renders whenever this harness owns that registry.
              An empty catalog is exactly when a user reaches for it, so it
              cannot depend on the catalog already having rows. */}
          <Show when={providerItems().length > 0 || showCustom()}>
            <div class="flex flex-col gap-3" data-component="harness-providers-section">
              <h3 class="text-14-medium text-text-strong">
                {language.t("settings.providers.section.harness", { harness: harnessLabel() })}
              </h3>
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
                  {(item) => {
                    const connected = () => connectedIds().has(item.id)
                    return (
                      <Show
                        when={connected()}
                        fallback={(
                          <ProviderSetupRow
                            id={item.id}
                            name={item.name}
                            status="missing"
                            providerId={item.id}
                            harness={scope.harness()}
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
                    )
                  }}
                </For>

                <Show when={showCustom()}>
                  <div
                    class="flex flex-wrap items-center justify-between gap-4 border-b border-border-weak-base py-3 last:border-none"
                    data-component="custom-provider-section"
                  >
                    <div class="flex min-w-0 items-center gap-3">
                      <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
                      <div class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-14-medium text-text-strong">{language.t("provider.custom.title")}</span>
                        <span class="text-12-regular text-text-weak">{language.t("settings.providers.custom.description")}</span>
                      </div>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                      <Button
                        size="large"
                        variant="secondary"
                        icon="plus-small"
                        onClick={() => dialog.show(() => <DialogCustomProvider back="close" scope={scope.scopeRef()} />)}
                      >
                        {language.t("common.connect")}
                      </Button>
                    </div>
                  </div>
                </Show>
              </SettingsList>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}
