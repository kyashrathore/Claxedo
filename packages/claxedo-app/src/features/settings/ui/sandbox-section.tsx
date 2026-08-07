import { createEffect, createMemo, createSignal, For, Show, type Component, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { showToast } from "@opencode-ai/ui/toast"
import { api, getDefaultBaseUrl } from "@/platform/api/api"
import { NetworkPolicySettings } from "./network-policy"
import { SandboxDriverLogo } from "./sandbox-driver-logo"
import { useSandboxOnboardingFunnel } from "../app-ports"
import {
  shouldUseSandboxDriverMutations,
  workspaceDefaultSandboxDriverUrl,
  workspaceSandboxDriverAuthUrl,
  workspaceSandboxDriversUrl,
} from "./sandbox-section-logic"

type Field = {
  key: string
  label: string
  secret?: boolean
}

// Mirrors `listSandboxDrivers` in @claxedo/sandbox-manager/driver-catalog —
// the control plane speaks "driver" on the wire even though this screen still
// says "provider" to the user.
type Driver = {
  id: string
  label: string
  fields: Field[]
  configured: boolean
  source: string
  default: boolean
}

type DriverResponse = {
  default_driver: string
  drivers: Driver[]
}

type DeleteDriverResponse = {
  ok: boolean
}

function errorTitle(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

// ── Shared row ──────────────────────────────────────────────────────────────

function SettingsRow(props: { title: string; description: string | JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 py-3">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}

/** Logo + name, shared by the Select trigger and its menu rows. */
function DriverLabel(props: { driver: Driver; class?: string }) {
  return (
    <span class="flex items-center gap-2 min-w-0">
      <SandboxDriverLogo
        id={props.driver.id}
        label={props.driver.label}
        class={`size-4 shrink-0 ${props.class ?? ""}`}
      />
      <span class="truncate">{props.driver.label}</span>
    </span>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

// You run cloud workspaces on ONE provider. The previous layout listed all
// seven at once, each with its own credential row and Configure button, so the
// screen was six repetitions of a thing you will never use next to the one you
// will. This picks the provider first and only ever shows that provider's
// credential form.
export const SandboxSettingsSection: Component = () => {
  const onboarding = useSandboxOnboardingFunnel()
  const baseUrl = getDefaultBaseUrl()
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal("")
  const [drivers, setDrivers] = createSignal<Driver[]>([])
  // `selected` is what the picker is pointing at; `serverDef` is what the
  // control plane will actually use. They differ while you are mid-change, and
  // the panel below is explicit about which is which.
  const [selected, setSelected] = createSignal("")
  const [serverDef, setServerDef] = createSignal("")
  const [authValues, setAuthValues] = createSignal<Record<string, Record<string, string>>>({})
  const canMutate = createMemo(() => shouldUseSandboxDriverMutations({ baseUrl }))
  const selectedDriver = createMemo(() => drivers().find((item) => item.id === selected()))
  const activeDriver = createMemo(() => drivers().find((item) => item.id === serverDef()))
  const isActive = createMemo(() => !!selected() && selected() === serverDef())

  async function load() {
    setLoading(true)
    try {
      const data = await api.get<DriverResponse>(
        workspaceSandboxDriversUrl({ baseUrl }),
      )
      setDrivers(data.drivers)
      setSelected(data.default_driver)
      setServerDef(data.default_driver)
    } finally {
      setLoading(false)
    }
  }

  createEffect(() => {
    void load().catch((err) => showToast({ variant: "error", title: errorTitle(err) }))
  })

  function getAuthValue(driverId: string, fieldKey: string): string {
    return authValues()[driverId]?.[fieldKey] ?? ""
  }

  function setAuthValue(driverId: string, fieldKey: string, value: string) {
    setAuthValues((prev) => ({
      ...prev,
      [driverId]: { ...prev[driverId], [fieldKey]: value },
    }))
  }

  // Every field must be filled before the server can build a credential —
  // `sandboxDriverManagedSecret` returns undefined on a partial set and the
  // save silently stores nothing, so gate the button on it instead.
  const canSaveCredentials = createMemo(() => {
    const driver = selectedDriver()
    if (!driver) return false
    return driver.fields.every((field) => getAuthValue(driver.id, field.key).trim().length > 0)
  })

  const save = async (id: string, fields: Field[]) => {
    if (!canMutate()) return
    setSaving(id)
    const label = drivers().find((item) => item.id === id)?.label ?? id
    try {
      const authObj = Object.fromEntries(fields.map((field) => [field.key, getAuthValue(id, field.key)]))
      // `default: true` — saving credentials for the provider you just picked
      // is also how you choose it, so this is one call, not two.
      const data = await api.put<DriverResponse>(
        workspaceSandboxDriverAuthUrl({ baseUrl, driverId: id }),
        { auth: authObj, default: true },
      )
      setDrivers(data.drivers)
      setSelected(data.default_driver)
      setServerDef(data.default_driver)
      setAuthValues((prev) => ({ ...prev, [id]: {} }))
      onboarding.emit({ name: "sandbox_provider_configured", provider: id })
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
    const label = drivers().find((item) => item.id === id)?.label ?? id
    try {
      await api.delete<DeleteDriverResponse>(
        workspaceSandboxDriverAuthUrl({ baseUrl, driverId: id }),
      )
      await load()
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
      const data = await api.put<DriverResponse>(
        workspaceDefaultSandboxDriverUrl({ baseUrl }),
        // `defaultBody` on the server parses `driver`; a `provider` key parses
        // to undefined and 400s with `sandbox_driver_unsupported`.
        { driver: selected() },
      )
      setDrivers(data.drivers)
      setSelected(data.default_driver)
      setServerDef(data.default_driver)
      showToast({ variant: "success", title: "Default sandbox provider updated" })
    } catch (err) {
      showToast({ variant: "error", title: errorTitle(err) })
    } finally {
      setSaving("")
    }
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
        <h2 class="text-18-medium text-text-strong">Sandbox Providers</h2>
        <p class="text-12-regular text-text-weak">
          Manage sandbox providers and network access for cloud workspaces.
        </p>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        {/* ── Provider picker ─────────────────────────────────────── */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Provider</h3>
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow title="Provider" description="Cloud workspaces run on one provider at a time.">
              <Select
                options={drivers()}
                current={selectedDriver()}
                value={(item) => item.id}
                label={(item) => item.label}
                // `children` is the menu row, `renderValue` the trigger — the
                // row carries the credential dot, the trigger must not.
                renderValue={(item) => <DriverLabel driver={item} />}
                onSelect={(item) => {
                  if (!canMutate()) return
                  if (!item) return
                  setSelected(item.id)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                disabled={!canMutate() || loading()}
              >
                {(item) =>
                  item ? (
                    <span class="flex items-center gap-2 min-w-0">
                      <DriverLabel driver={item} />
                      <Show when={item.configured}>
                        <span
                          aria-hidden="true"
                          class="shrink-0 size-1.5 rounded-full bg-surface-success-strong"
                        />
                      </Show>
                    </span>
                  ) : null
                }
              </Select>
            </SettingsRow>
          </div>
          <Show when={!canMutate()}>
            <p class="text-12-regular text-text-weak mt-2">
              Signed hosted sessions can view local sandbox providers but cannot change local credentials.
            </p>
          </Show>
        </div>

        {/* ── Selected provider ───────────────────────────────────── */}
        <Show when={selectedDriver()}>
          {(driver) => (
            <div class="flex flex-col gap-1">
              <h3 class="text-14-medium text-text-strong pb-2">Credentials</h3>
              <div class="bg-surface-raised-base rounded-lg p-4 flex flex-col gap-4">
                <div class="flex items-center gap-3">
                  <SandboxDriverLogo
                    id={driver().id}
                    label={driver().label}
                    class="size-5 shrink-0 text-text-strong"
                  />
                  <div class="flex flex-col gap-0.5 min-w-0">
                    <span class="text-14-medium text-text-strong">{driver().label}</span>
                    <span class="text-12-regular text-text-weak">
                      {driver().configured ? "Credentials configured" : "Not configured"}
                    </span>
                  </div>
                </div>

                <div class="flex flex-wrap items-end gap-2">
                  <For each={driver().fields}>
                    {(field) => {
                      // A placeholder is not a label: it disappears on first
                      // keystroke and screen readers treat it as a hint, so
                      // these secret fields had no durable name.
                      const fieldId = `sandbox-${driver().id}-${field.key}`
                      return (
                        <div class="flex flex-1 min-w-[160px] flex-col gap-1">
                          <label for={fieldId} class="text-12-regular text-text-weak">
                            {field.label}
                          </label>
                          <input
                            id={fieldId}
                            type={field.secret ? "password" : "text"}
                            value={getAuthValue(driver().id, field.key)}
                            onInput={(e) => setAuthValue(driver().id, field.key, e.currentTarget.value)}
                            placeholder={driver().configured ? "••••••••" : field.label}
                            disabled={!canMutate()}
                            class="w-full rounded-md border border-border-weak-base bg-surface-inset-base px-3 py-2 text-12-regular text-text-strong placeholder:text-text-weak/40 focus:outline-none focus:ring-1 focus:ring-border-interactive-focus focus:border-border-interactive-base/40 transition-colors"
                          />
                        </div>
                      )
                    }}
                  </For>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    size="small"
                    variant="primary"
                    disabled={!canMutate() || !canSaveCredentials() || saving() === driver().id}
                    onClick={() => void save(driver().id, driver().fields)}
                  >
                    {saving() === driver().id ? "Saving..." : "Save"}
                  </Button>
                  {/* Only reachable when the provider already has credentials
                      and is not the active one — switching to it must not
                      require retyping a key you already stored. */}
                  <Show when={driver().configured && !isActive()}>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={!canMutate() || saving() === "default"}
                      onClick={() => void saveDefault()}
                    >
                      {saving() === "default" ? "Saving..." : "Use for new workspaces"}
                    </Button>
                  </Show>
                  <Show when={driver().configured}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={!canMutate() || saving() === driver().id}
                      onClick={() => void clear(driver().id)}
                    >
                      Remove
                    </Button>
                  </Show>
                </div>
              </div>

              {/* The server rejects creation with
                  `sandbox_driver_credentials_missing` when the active provider
                  has no credentials — say so here rather than at create time. */}
              <Show when={!loading() && activeDriver() && !activeDriver()!.configured}>
                <div class="mt-2 flex items-start gap-2.5 rounded-lg border border-border-weak-base px-3 py-2.5">
                  <span aria-hidden="true" class="mt-1.5 shrink-0 size-1.5 rounded-full bg-surface-warning-strong" />
                  <p class="text-12-regular text-text-weak">
                    <span class="text-text-strong">{activeDriver()!.label}</span> is active but has no
                    credentials. Cloud workspaces will fail to create until you add them.
                  </p>
                </div>
              </Show>
            </div>
          )}
        </Show>

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
