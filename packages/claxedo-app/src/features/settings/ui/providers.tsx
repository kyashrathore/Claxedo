import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogCustomProvider, localHarnessChecks, useProviders, type LocalHarnessStatus } from "@/features/settings/app-ports"
import { createEffect, createMemo, createSignal, type Component, For, Show } from "solid-js"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"
import { SettingsList } from "@/features/settings/ui/list"
import { useLanguage } from "@/platform/i18n/provider"
import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { queryClient } from "@/platform/query/query-client"
import { agentSetupStatus, listStoredCredentialProviders, runProviderDetect } from "@/features/settings/provider-detect"
import {
  canDisconnectProvider,
  disconnectOpenCodeProvider,
  providerSourceTagKey,
  removeProviderAuthEntry,
} from "@/features/settings/provider-settings-logic"
import { ProviderSetupRow } from "@/features/settings/ui/provider-setup-row"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]
type HarnessCheckId = ReturnType<typeof localHarnessChecks>[number]["id"]

const AGENT_CONNECT: Record<HarnessCheckId, string> = {
  claude: "claude-sdk",
  codex: "codex-app-server",
  cursor: "cursor-sdk",
}

const AGENT_ICON: Record<HarnessCheckId, string> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
}

const PI_PROVIDER_IDS = ["anthropic", "openai", "openai-codex"] as const

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
  // Must pass "opencode" explicitly — unqualified `/provider` resolves to the
  // workspace default harness (agents), not the OpenCode catalog.
  const openCodeProviders = useProviders("opencode")
  const piProviders = useProviders("pi")
  const providerList = createMemo(() => openCodeProviders.state())
  const providerItems = createMemo(() => Array.from(providerList().all.values()))

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const [search, setSearch] = createSignal("")
  const [detecting, setDetecting] = createSignal(false)
  const [storedProviders, setStoredProviders] = createSignal<Set<string>>(new Set())
  const [agentStatuses, setAgentStatuses] = createSignal<LocalHarnessStatus[]>([])

  const refreshProviderQueries = async () => {
    await Promise.all([openCodeProviders.refresh(), piProviders.refresh()])
  }

  const refreshDetect = async () => {
    setDetecting(true)
    try {
      const result = await runProviderDetect()
      setStoredProviders(result.stored)
      setAgentStatuses(result.agents)
      await refreshProviderQueries()
    } catch (err: unknown) {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDetecting(false)
    }
  }

  createEffect(() => {
    void listStoredCredentialProviders()
      .then((stored) => {
        setStoredProviders(stored)
        setAgentStatuses(localHarnessChecks().map((check) => ({
          id: check.id,
          label: check.label,
          signIn: check.signIn,
          state: stored.has(AGENT_CONNECT[check.id]) ? "working" as const : "missing" as const,
        })))
      })
      .catch(() => undefined)
  })

  createEffect(() => {
    const ids = providerList().connected.filter((id) => {
      const provider = providerList().all.get(id)
      return provider && source(provider) === undefined
    })
    if (ids.length === 0) return
    // Hydrate connected rows in the background; some env-only providers are listed
    // as connected but have no runtime catalog entry — that must not interrupt Detect.
    void Promise.allSettled(ids.map((id) => openCodeProviders.load(id)))
  })

  const openCodeRows = createMemo(() => {
    const query = search().trim().toLowerCase()
    const connected = new Set(providerList().connected)
    return providerItems()
      .filter((item) => {
        if (query) {
          return item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query)
        }
        return popularProviders.includes(item.id) || connected.has(item.id)
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const piRows = createMemo(() =>
    PI_PROVIDER_IDS.flatMap((id) => {
      const provider = piProviders.all().get(id)
      return provider ? [provider] : []
    }),
  )

  const type = (item: ProviderItem) => language.t(providerSourceTagKey(source(item)))

  const canDisconnect = (item: ProviderItem) => canDisconnectProvider(source(item))
  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const refreshProviders = async () => {
    await refreshProviderQueries()
    await refreshDetect()
  }

  const markOpenCodeDisconnected = (providerID: string) => {
    const patch = (cached: NormalizedProviderListResponse | undefined) => {
      if (!cached) return cached
      return {
        ...cached,
        connected: cached.connected.filter((item) => item !== providerID),
      }
    }
    queryClient.setQueryData<NormalizedProviderListResponse | undefined>(openCodeProviders.queryKey(), patch)
  }

  const disconnect = async (providerID: string, name: string) => {
    const item = providerList().all.get(providerID)
    await disconnectOpenCodeProvider({
      providerId: providerID,
      name,
      deleteCredential: async (id) => {
        await claxedoCredentialRequest({ providerId: id }, { method: "DELETE" })
      },
      removeAuth: async (id) => {
        await removeProviderAuthEntry({
          serverUrl: getClaxedoServerUrl(),
          providerId: id,
          request: authFetch,
        })
      },
      markDisconnected: markOpenCodeDisconnected,
      refresh: refreshProviderQueries,
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

  const openCodeConnected = createMemo(() => new Set(providerList().connected))
  const piConnected = createMemo(() => new Set(piProviders.connected().map((item) => item.id)))

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
        <h2 class="text-18-medium text-text-strong">{language.t("settings.providers.title")}</h2>
        <p class="text-12-regular text-text-weak">{language.t("settings.providers.description")}</p>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <div class="flex flex-col gap-3" data-component="agents-providers-section">
          <div class="flex items-center justify-between gap-4">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.providers.section.agents")}</h3>
            <Button size="small" variant="ghost" disabled={detecting()} onClick={() => void refreshDetect()}>
              {detecting() ? language.t("settings.providers.detect.running") : language.t("settings.providers.detect.action")}
            </Button>
          </div>
          <SettingsList>
            <For each={[...localHarnessChecks()]}>
              {(check) => {
                const status = () => agentSetupStatus(check, storedProviders(), agentStatuses())
                return (
                  <ProviderSetupRow
                    id={AGENT_ICON[check.id]}
                    name={check.label}
                    status={status().status}
                    detail={status().detail}
                    providerId={AGENT_CONNECT[check.id]}
                    harness={AGENT_CONNECT[check.id]}
                    note={language.t("settings.providers.agents.sharedCredential")}
                    onConnected={() => refreshProviders()}
                  />
                )
              }}
            </For>
          </SettingsList>
        </div>

        <div class="flex flex-col gap-3" data-component="pi-providers-section">
          <div class="flex flex-col gap-1">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.providers.section.pi")}</h3>
            <p class="text-12-regular text-text-weak">{language.t("settings.providers.pi.description")}</p>
          </div>
          <SettingsList>
            <For each={piRows()}>
              {(item) => (
                <ProviderSetupRow
                  id={item.id}
                  name={item.name}
                  status={piConnected().has(item.id) ? "connected" : "missing"}
                  providerId={item.id}
                  harness="pi"
                  onConnected={() => refreshProviders()}
                />
              )}
            </For>
          </SettingsList>
        </div>

        <div class="flex flex-col gap-3" data-component="opencode-providers-section">
          <h3 class="text-14-medium text-text-strong">{language.t("settings.providers.section.opencode")}</h3>
          <TextField
            label={language.t("settings.providers.search.label")}
            placeholder={language.t("settings.providers.search.placeholder")}
            value={search()}
            onChange={setSearch}
          />
          <SettingsList>
            <For each={openCodeRows()}>
              {(item) => {
                const connected = () => openCodeConnected().has(item.id)
                return (
                  <Show
                    when={connected()}
                    fallback={(
                      <ProviderSetupRow
                        id={item.id}
                        name={item.name}
                        status="missing"
                        providerId={item.id}
                        harness="opencode"
                        note={note(item.id) ? language.t(note(item.id)!) : undefined}
                        onConnected={() => refreshProviders()}
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
                          <Button size="large" variant="ghost" onClick={() => void disconnect(item.id, item.name)}>
                            {language.t("common.disconnect")}
                          </Button>
                        </Show>
                      </div>
                    </div>
                  </Show>
                )
              }}
            </For>

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
                <Button size="large" variant="secondary" icon="plus-small" onClick={() => dialog.show(() => <DialogCustomProvider back="close" />)}>
                  {language.t("common.connect")}
                </Button>
              </div>
            </div>
          </SettingsList>
        </div>
      </div>
    </div>
  )
}
