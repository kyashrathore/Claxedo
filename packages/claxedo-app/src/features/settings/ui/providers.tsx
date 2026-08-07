import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { showToast } from "@opencode-ai/ui/toast"
import { popularProviders } from "@/platform/query/provider-list"
import { DialogAIConnect, DialogConnectProvider, DialogCustomProvider, DialogSelectProvider, useGlobalSDK, useProviders, useShellQueryOptions as useQueryOptions } from "@/features/settings/app-ports"
import { createEffect, createMemo, type Component, For, Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Config } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { useLanguage } from "@/platform/i18n/provider"
import { SettingsList } from "@/features/settings/ui/list"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { queryClient } from "@/platform/query/query-client"

type ProviderSource = "env" | "api" | "config" | "custom"
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

export const SettingsProviders: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const queryOptions = useQueryOptions()
  const configQuery = useQuery(() => queryOptions.globalConfig())
  const providers = useProviders()
  const providerList = createMemo(() => providers.state())
  const providerItems = createMemo(() => Array.from(providerList().all.values()))
  const config = createMemo(() => configQuery.data ?? {})

  const connected = createMemo(() =>
    providerItems()
      .filter((p) => providerList().connected.includes(p.id))
      .filter((p) => p.id !== "opencode" || Object.values(p.models).find((m) => m.cost?.input)),
  )

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providerItems()
      .filter((p) => popularProviders.includes(p.id))
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  createEffect(() => {
    const ids = providerList().connected.filter((id) => {
      const provider = providerList().all.get(id)
      return provider && source(provider) === undefined
    })
    if (ids.length === 0) return
    void Promise.all(ids.map((id) => providers.load(id))).catch((err: unknown) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    })
  })

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => source(item) !== "env"
  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const isConfigCustom = (providerID: string) => {
    const provider = config().provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const disableProvider = async (providerID: string, name: string) => {
    const before = config().disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    queryClient.setQueryData<Config>(queryOptions.globalConfig().queryKey, {
      ...config(),
      disabled_providers: next,
    })

    await globalSDK.client.global.config
      .update({ config: { disabled_providers: next } })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: queryOptions.globalConfig().queryKey })
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        queryClient.setQueryData<Config>(queryOptions.globalConfig().queryKey, {
          ...config(),
          disabled_providers: before,
        })
        showToast({ title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) })
      })
  }

  const disconnect = async (providerID: string, name: string) => {
    if (isConfigCustom(providerID)) {
      await claxedoCredentialRequest({ providerId: providerID }, {
        method: "DELETE",
      })
        .then(async () => {
          await disableProvider(providerID, name)
          void queryClient.invalidateQueries({ queryKey: queryOptions.providers(null).queryKey })
        })
        .catch((err: unknown) => {
          showToast({ title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) })
        })
      return
    }
    await claxedoCredentialRequest({ providerId: providerID }, {
      method: "DELETE",
    })
      .then(() => {
        queryClient.setQueryData<NormalizedProviderListResponse | undefined>(
          queryOptions.providers(null).queryKey,
          (cached) => {
            const providers = cached ?? providerList()
            return {
              ...providers,
              connected: providers.connected.filter((item) => item !== providerID),
            }
          },
        )
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: err instanceof Error ? err.message : String(err) })
      })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
        <h2 class="text-18-medium text-text-strong">{language.t("settings.providers.title")}</h2>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex items-center justify-between gap-4 rounded-md border border-border-weak-base p-4">
          <div class="flex flex-col gap-1">
            <h3 class="text-14-medium text-text-strong">Connect your AI</h3>
            <p class="text-12-regular text-text-weak">Detect subscriptions on this machine or enter an API key.</p>
          </div>
          <Button size="large" variant="secondary" icon="plus-small" onClick={() => dialog.show(() => <DialogAIConnect />)}>
            Detect or connect
          </Button>
        </div>

        <div class="flex flex-col gap-1" data-component="connected-providers-section">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.providers.section.connected")}</h3>
          <SettingsList>
            <Show
              when={connected().length > 0}
              fallback={<div class="py-4 text-14-regular text-text-weak">{language.t("settings.providers.connected.empty")}</div>}
            >
              <For each={connected()}>
                {(item) => (
                  <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center gap-3 min-w-0">
                      <ProviderIcon id={item.id} class="size-5 shrink-0 icon-strong-base" />
                      <span class="text-14-medium text-text-strong truncate">{item.name}</span>
                      <Tag>{type(item)}</Tag>
                    </div>
                    <Show
                      when={canDisconnect(item)}
                      fallback={
                        <span class="text-14-regular text-text-base opacity-0 group-hover:opacity-100 transition-opacity duration-200 pr-3 cursor-default">
                          {language.t("settings.providers.connected.environmentDescription")}
                        </span>
                      }
                    >
                      <Button size="large" variant="ghost" onClick={() => void disconnect(item.id, item.name)}>
                        {language.t("common.disconnect")}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsList>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.providers.section.popular")}</h3>
          <SettingsList>
            <For each={popular()}>
              {(item) => (
                <div class="flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex flex-col min-w-0">
                    <div class="flex items-center gap-x-3">
                      <ProviderIcon id={item.id} class="size-5 shrink-0 icon-strong-base" />
                      <span class="text-14-medium text-text-strong">{item.name}</span>
                    </div>
                    <Show when={note(item.id)}>
                      {(key) => <span class="text-12-regular text-text-weak pl-8">{language.t(key())}</span>}
                    </Show>
                  </div>
                  <Button size="large" variant="secondary" icon="plus-small" onClick={() => dialog.show(() => <DialogConnectProvider provider={item.id} />)}>
                    {language.t("common.connect")}
                  </Button>
                </div>
              )}
            </For>

            <div class="flex items-center justify-between gap-4 min-h-16 border-b border-border-weak-base last:border-none flex-wrap py-3" data-component="custom-provider-section">
              <div class="flex flex-col min-w-0">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
                  <span class="text-14-medium text-text-strong">{language.t("provider.custom.title")}</span>
                  <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                </div>
                <span class="text-12-regular text-text-weak pl-8">{language.t("settings.providers.custom.description")}</span>
              </div>
              <Button size="large" variant="secondary" icon="plus-small" onClick={() => dialog.show(() => <DialogCustomProvider back="close" />)}>
                {language.t("common.connect")}
              </Button>
            </div>
          </SettingsList>

          <Button
            variant="ghost"
            class="px-0 py-0 mt-5 text-14-medium text-text-interactive-base text-left justify-start hover:bg-transparent active:bg-transparent"
            onClick={() => dialog.show(() => <DialogSelectProvider />)}
          >
            {language.t("dialog.provider.viewAll")}
          </Button>
        </div>
      </div>
    </div>
  )
}
