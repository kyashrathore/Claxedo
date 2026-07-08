import { createEffect, createMemo, createSignal, For, Show, type Component, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { showToast } from "@opencode-ai/ui/toast"
import { api, getDefaultBaseUrl } from "../utils/api"
import { NetworkPolicySettings } from "./network-policy-settings"
import {
  shouldUseSandboxDriverMutations,
  workspaceDefaultProviderUrl,
  workspaceProviderAuthUrl,
  workspaceProvidersUrl,
} from "./settings-sandbox-section-helpers"

type Field = {
  key: string
  label: string
  secret?: boolean
}

type Provider = {
  id: string
  label: string
  fields: Field[]
  configured: boolean
  source: string
  default: boolean
}

type ProviderResponse = {
  default_provider: string
  providers: Provider[]
}

type DeleteProviderResponse = {
  ok: boolean
}

function errorTitle(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

// ── Shared row ──────────────────────────────────────────────────────────────

function SettingsRow(props: { title: string; description: string | JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export const SandboxSettingsSection: Component = () => {
  const baseUrl = getDefaultBaseUrl()
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal("")
  const [providers, setProviders] = createSignal<Provider[]>([])
  const [def, setDef] = createSignal("")
  const [serverDef, setServerDef] = createSignal("")
  const [authValues, setAuthValues] = createSignal<Record<string, Record<string, string>>>({})
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const canMutate = createMemo(() => shouldUseSandboxDriverMutations({ baseUrl }))

  async function load() {
    setLoading(true)
    try {
      const data = await api.get<ProviderResponse>(
        workspaceProvidersUrl({ baseUrl }),
      )
      setProviders(data.providers)
      setDef(data.default_provider)
      setServerDef(data.default_provider)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void load().catch((err) => showToast({ variant: "error", title: errorTitle(err) }))
  })

  function getAuthValue(providerId: string, fieldKey: string): string {
    return authValues()[providerId]?.[fieldKey] ?? ""
  }

  function setAuthValue(providerId: string, fieldKey: string, value: string) {
    setAuthValues((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], [fieldKey]: value },
    }))
  }

  const save = async (id: string, fields: Field[]) => {
    if (!canMutate()) return
    setSaving(id)
    const label = providers().find((p) => p.id === id)?.label ?? id
    try {
      const authObj = Object.fromEntries(fields.map((field) => [field.key, getAuthValue(id, field.key)]))
      const body = { auth: authObj, default: def() === id }
      const data = await api.put<ProviderResponse>(
        workspaceProviderAuthUrl({ baseUrl, providerId: id }),
        body,
      )
      setProviders(data.providers)
      setDef(data.default_provider)
      setServerDef(data.default_provider)
      setExpanded(null)
      showToast({ variant: "success", title: `${label} credentials saved` })
    } catch (err) {
      showToast({ variant: "error", title: errorTitle(err) })
    } finally {
      setSaving("")
    }
  }

  const clear = async (id: string) => {
    if (!canMutate()) return
    setSaving(id)
    const label = providers().find((p) => p.id === id)?.label ?? id
    try {
      await api.delete<DeleteProviderResponse>(
        workspaceProviderAuthUrl({ baseUrl, providerId: id }),
      )
      await load()
      setExpanded(null)
      showToast({ variant: "success", title: `${label} credentials removed` })
    } catch (err) {
      showToast({ variant: "error", title: errorTitle(err) })
    } finally {
      setSaving("")
    }
  }

  const saveDefault = async () => {
    if (!canMutate()) return
    setSaving("default")
    try {
      const data = await api.put<ProviderResponse>(
        workspaceDefaultProviderUrl({ baseUrl }),
        { provider: def() },
      )
      setProviders(data.providers)
      setDef(data.default_provider)
      setServerDef(data.default_provider)
      showToast({ variant: "success", title: "Default sandbox provider updated" })
    } catch (err) {
      showToast({ variant: "error", title: errorTitle(err) })
    } finally {
      setSaving("")
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      {/* Sticky header */}
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">Sandbox Providers</h2>
          <p class="text-13-regular text-text-weak">
            Manage sandbox providers and network access for cloud workspaces.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        {/* ── Default provider ────────────────────────────────────── */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Default Provider</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow title="Default" description="Provider used when creating new cloud workspaces.">
              <div class="flex items-center gap-2">
                <Select
                  options={providers()}
                  current={providers().find((item) => item.id === def())}
                  value={(item) => item.id}
                  label={(item) => item.label}
                  onSelect={(item) => {
                    if (!canMutate()) return
                    if (!item) return
                    setDef(item.id)
                  }}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                  disabled={!canMutate() || loading()}
                />
                <Show when={def() !== serverDef()}>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={!canMutate() || saving() === "default"}
                    onClick={() => void saveDefault()}
                  >
                    {saving() === "default" ? "Saving..." : "Save"}
                  </Button>
                </Show>
              </div>
            </SettingsRow>
          </div>
          <Show when={!canMutate()}>
            <p class="text-12-regular text-text-weak mt-1">
              Signed hosted sessions can view local sandbox providers but cannot change local credentials.
            </p>
          </Show>
        </div>

        {/* ── Provider credentials ────────────────────────────────── */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Credentials</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <For each={providers()}>
              {(item) => {
                const isExpanded = () => expanded() === item.id

                return (
                  <div class="py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center justify-between gap-4">
                      <div class="flex items-center gap-3 min-w-0">
                        <div
                          class="shrink-0 size-2 rounded-full transition-colors"
                          classList={{
                            "bg-surface-success-strong": item.configured,
                            "bg-border-base": !item.configured,
                          }}
                        />
                        <div class="flex flex-col gap-0.5">
                          <span class="text-14-medium text-text-strong">{item.label}</span>
                          <span class="text-12-regular text-text-weak">
                            {item.configured ? "Credentials configured" : "Not configured"}
                            {item.configured && def() === item.id ? " \u00b7 Default" : ""}
                          </span>
                        </div>
                      </div>

                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={item.configured}>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={!canMutate() || saving() === item.id}
                            onClick={() => void clear(item.id)}
                          >
                            Remove
                          </Button>
                        </Show>
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={!canMutate()}
                          onClick={() => setExpanded(isExpanded() ? null : item.id)}
                        >
                          {isExpanded() ? "Collapse" : item.configured ? "Update" : "Configure"}
                        </Button>
                      </div>
                    </div>

                    {/* Expandable credential form */}
                    <Show when={isExpanded()}>
                      <div class="mt-3 pt-3 border-t border-border-weak-base">
                        <div class="flex flex-wrap items-end gap-2">
                          <For each={item.fields}>
                            {(field) => (
                              <input
                                type={field.secret ? "password" : "text"}
                                value={getAuthValue(item.id, field.key)}
                                onInput={(e) => setAuthValue(item.id, field.key, e.currentTarget.value)}
                                placeholder={field.label}
                                disabled={!canMutate()}
                                class="flex-1 min-w-[160px] rounded-md border border-border-weak-base bg-surface-inset-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/40 focus:outline-none focus:ring-1 focus:ring-border-interactive-focus focus:border-border-interactive-base/40 transition-colors"
                              />
                            )}
                          </For>
                          <Button
                            size="small"
                            variant="primary"
                            disabled={!canMutate() || saving() === item.id}
                            onClick={() => void save(item.id, item.fields)}
                          >
                            {saving() === item.id ? "Saving..." : "Save"}
                          </Button>
                        </div>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>

          <Show when={canMutate() && !loading() && providers().every((item) => !item.configured)}>
            <p class="text-12-regular text-text-weak mt-1">
              Add credentials for at least one provider to create cloud workspaces.
            </p>
          </Show>
        </div>

        {/* ── Network policy ─────────────────────────────────────── */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Network Policy</h3>
          <div class="bg-surface-raised-base px-4 py-4 rounded-lg">
            <NetworkPolicySettings />
          </div>
        </div>
      </div>
    </div>
  )
}
