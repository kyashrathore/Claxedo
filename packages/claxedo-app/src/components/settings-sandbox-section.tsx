import { createEffect, createSignal, For, Show, type Component, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { showToast } from "@opencode-ai/ui/toast"
import { api, getDefaultBaseUrl } from "../utils/api"

type Provider = {
  id: "daytona" | "modal"
  label: string
  configured: boolean
}

type Response = {
  default_provider: "daytona" | "modal"
  providers: Provider[]
}

type Auth = {
  daytona: { api_key: string }
  modal: { token_id: string; token_secret: string }
}

// ── Field definitions per provider ──────────────────────────────────────────

type FieldDef = {
  key: string
  placeholder: string
  get: (auth: Auth) => string
  set: (auth: Auth, value: string) => Auth
}

const PROVIDER_FIELDS: Record<"daytona" | "modal", FieldDef[]> = {
  daytona: [
    {
      key: "api_key",
      placeholder: "DAYTONA_API_KEY",
      get: (a) => a.daytona.api_key,
      set: (a, v) => ({ ...a, daytona: { api_key: v } }),
    },
  ],
  modal: [
    {
      key: "token_id",
      placeholder: "MODAL_TOKEN_ID",
      get: (a) => a.modal.token_id,
      set: (a, v) => ({ ...a, modal: { ...a.modal, token_id: v } }),
    },
    {
      key: "token_secret",
      placeholder: "MODAL_TOKEN_SECRET",
      get: (a) => a.modal.token_secret,
      set: (a, v) => ({ ...a, modal: { ...a.modal, token_secret: v } }),
    },
  ],
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
  const [def, setDef] = createSignal<"daytona" | "modal">("daytona")
  const [serverDef, setServerDef] = createSignal<"daytona" | "modal">("daytona")
  const [auth, setAuth] = createSignal<Auth>({
    daytona: { api_key: "" },
    modal: { token_id: "", token_secret: "" },
  })
  const [expanded, setExpanded] = createSignal<"daytona" | "modal" | null>(null)

  async function load() {
    setLoading(true)
    try {
      const data = await api.get<Response>(`${baseUrl}/api/workspace/providers`)
      setProviders(data.providers)
      setDef(data.default_provider)
      setServerDef(data.default_provider)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void load()
  })

  const save = async (id: "daytona" | "modal") => {
    setSaving(id)
    try {
      const a = auth()
      const body =
        id === "daytona"
          ? { auth: { api_key: a.daytona.api_key }, default: def() === id }
          : { auth: { token_id: a.modal.token_id, token_secret: a.modal.token_secret }, default: def() === id }
      const data = await api.put<Response>(`${baseUrl}/api/workspace/providers/${id}/auth`, body)
      setProviders(data.providers)
      setDef(data.default_provider)
      setExpanded(null)
      showToast({ variant: "success", title: `${id === "daytona" ? "Daytona" : "Modal"} credentials saved` })
    } catch (err) {
      showToast({ variant: "error", title: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving("")
    }
  }

  const clear = async (id: "daytona" | "modal") => {
    setSaving(id)
    try {
      const data = await api.delete<Response>(`${baseUrl}/api/workspace/providers/${id}/auth`)
      setProviders(data.providers)
      setDef(data.default_provider)
      setExpanded(null)
      showToast({ variant: "success", title: `${id === "daytona" ? "Daytona" : "Modal"} credentials removed` })
    } catch (err) {
      showToast({ variant: "error", title: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving("")
    }
  }

  const saveDefault = async () => {
    setSaving("default")
    try {
      const data = await api.put<Response>(`${baseUrl}/api/workspace/providers/default`, { provider: def() })
      setProviders(data.providers)
      setDef(data.default_provider)
      setServerDef(data.default_provider)
      showToast({ variant: "success", title: "Default compute provider updated" })
    } catch (err) {
      showToast({ variant: "error", title: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving("")
    }
  }

  const isConfigured = (id: "daytona" | "modal") =>
    providers().find((p) => p.id === id)?.configured ?? false

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      {/* Sticky header — matches SettingsProviders / SettingsModels pattern */}
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">Compute Providers</h2>
          <p class="text-13-regular text-text-weak">
            Manage sandbox providers for cloud workspaces.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        {/* Default provider */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Default Provider</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title="Default"
              description="Provider used when creating new cloud workspaces."
            >
              <div class="flex items-center gap-2">
                <Select
                  options={providers()}
                  current={providers().find((item) => item.id === def())}
                  value={(item) => item.id}
                  label={(item) => item.label}
                  onSelect={(item) => {
                    if (!item) return
                    setDef(item.id)
                  }}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
                <Show when={def() !== serverDef()}>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={saving() === "default"}
                    onClick={() => void saveDefault()}
                  >
                    {saving() === "default" ? "Saving..." : "Save"}
                  </Button>
                </Show>
              </div>
            </SettingsRow>
          </div>
        </div>

        {/* Provider credentials */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Credentials</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <For each={providers()}>
              {(item) => {
                const configured = () => isConfigured(item.id)
                const isExpanded = () => expanded() === item.id
                const fields = PROVIDER_FIELDS[item.id]

                return (
                  <div class="py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center justify-between gap-4">
                      <div class="flex items-center gap-3 min-w-0">
                        {/* Status dot */}
                        <div
                          class="shrink-0 size-2 rounded-full transition-colors"
                          classList={{
                            "bg-green-500": configured(),
                            "bg-border-base": !configured(),
                          }}
                        />
                        <div class="flex flex-col gap-0.5">
                          <span class="text-14-medium text-text-strong">{item.label}</span>
                          <span class="text-12-regular text-text-weak">
                            {configured() ? "Credentials configured" : "Not configured"}
                            {configured() && def() === item.id ? " \u00b7 Default" : ""}
                          </span>
                        </div>
                      </div>

                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={configured()}>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={saving() === item.id}
                            onClick={() => void clear(item.id)}
                          >
                            Remove
                          </Button>
                        </Show>
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => setExpanded(isExpanded() ? null : item.id)}
                        >
                          {configured() ? "Update" : "Configure"}
                        </Button>
                      </div>
                    </div>

                    {/* Expandable credential form */}
                    <Show when={isExpanded()}>
                      <div class="mt-3 pt-3 border-t border-border-weak-base">
                        <div class="flex flex-wrap items-end gap-2">
                          <For each={fields}>
                            {(field) => (
                              <input
                                type="password"
                                value={field.get(auth())}
                                onInput={(e) => setAuth((prev) => field.set(prev, e.currentTarget.value))}
                                placeholder={field.placeholder}
                                class="flex-1 min-w-[160px] rounded-md border border-border-weak-base bg-surface-inset-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/40 focus:outline-none focus:ring-1 focus:ring-accent-base focus:border-accent-base/40 transition-colors"
                              />
                            )}
                          </For>
                          <Button
                            size="small"
                            variant="primary"
                            disabled={saving() === item.id}
                            onClick={() => void save(item.id)}
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

          <Show when={!loading() && providers().every((item) => !item.configured)}>
            <p class="text-12-regular text-text-weak mt-1">
              Add credentials for at least one provider to create cloud workspaces.
            </p>
          </Show>
        </div>
      </div>
    </div>
  )
}
