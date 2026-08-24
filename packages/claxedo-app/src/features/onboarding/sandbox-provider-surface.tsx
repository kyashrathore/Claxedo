import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { For, Show, createMemo, createSignal, onSettled, type Component } from "solid-js"
import { workspaceSandboxDriverAuthUrl } from "./app-ports"
import {
  canSaveSandboxProvider,
  saveSandboxProviderKey,
  type SandboxProviderCatalog,
  type SandboxProviderOption,
  type SandboxProviderWriter,
} from "./sandbox-provider-api"
import type { SetupStepSubmit } from "./ai-connect-surface"

export type SandboxProviderSurfaceProps = {
  catalog?: SandboxProviderCatalog
  loading?: boolean
  baseUrl?: string
  write?: SandboxProviderWriter
  /** Defaults to the injected app port; overridable so the surface tests alone. */
  authUrl?: (input: { baseUrl?: string; driverId: string }) => string
  onConfigured?: () => void | Promise<void>
  registerSubmit?: (submit: SetupStepSubmit) => void
}

/**
 * The sandbox provider key, asked for in the flow rather than in a Settings
 * detour.
 *
 * The server rejects workspace creation with
 * `sandbox_driver_credentials_missing` when the active provider carries no
 * credentials, so this has to be satisfiable before compute is attempted — and
 * a user who said "local" never sees it at all.
 */
export const SandboxProviderSurface: Component<SandboxProviderSurfaceProps> = (props) => {
  const [picked, setPicked] = createSignal<string>()
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [saved, setSaved] = createSignal(false)

  const providers = () => props.catalog?.providers ?? []
  const selected = createMemo<SandboxProviderOption | undefined>(() => {
    const id = picked() ?? props.catalog?.defaultProviderId
    return providers().find((provider) => provider.id === id) ?? providers()[0]
  })
  const ready = createMemo(() => {
    const provider = selected()
    return !!provider && canSaveSandboxProvider(provider, values())
  })

  async function save() {
    const provider = selected()
    if (!provider || !ready()) return
    setBusy(true)
    setFailure(undefined)
    const outcome = await saveSandboxProviderKey({
      baseUrl: props.baseUrl,
      providerId: provider.id,
      values: Object.fromEntries(provider.fields.map((field) => [field.key, values()[field.key] ?? ""])),
      ...(props.write ? { write: props.write } : {}),
      authUrl: props.authUrl ?? workspaceSandboxDriverAuthUrl,
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.reason)
      return
    }
    setSaved(true)
    setValues({})
    await props.onConfigured?.()
  }

  onSettled(() => {
    props.registerSubmit?.({ run: save, count: () => (ready() ? 1 : 0), busy })
  })

  return (
    <div class="setup-block" data-component="sandbox-provider-surface" data-provider={selected()?.id ?? "none"}>
      <Show when={props.loading}>
        <div class="flex items-center gap-2 text-13-regular text-text-base">
          <Spinner />
          Loading sandbox providers…
        </div>
      </Show>

      <Show when={!props.loading && providers().length === 0}>
        <p class="text-13-regular text-text-weak">
          This server offers no sandbox providers, so cloud workspaces aren't available from here.
        </p>
      </Show>

      {/* You run cloud workspaces on ONE provider, so this picks the provider
          first and only ever shows that provider's key fields. */}
      <Show when={providers().length > 1}>
        <div class="setup-rows">
          <For each={providers()}>
            {(provider) => (
              <button
                type="button"
                class="setup-row"
                data-option={provider.id}
                aria-pressed={
                  (selected()?.id === provider.id) == null
                    ? undefined
                    : selected()?.id === provider.id
                      ? "true"
                      : "false"
                }
                onClick={() => {
                  setPicked(provider.id)
                  setValues({})
                  setFailure(undefined)
                }}
              >
                <span class="setup-row-copy">
                  <span class="text-13-medium text-text-strong">{provider.label}</span>
                  <Show when={provider.configured}>
                    <span class="setup-row-consequence text-12-regular">Already has a key on this machine.</span>
                  </Show>
                </span>
                <Show when={selected()?.id === provider.id}>
                  <Icon name="chevron-right" size="small" class="setup-row-chevron" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={selected()}>
        {(provider) => (
          <div class="setup-block">
            {/* With a single provider the picker above is absent, so without
                this the user is asked for "an API key" with nothing on screen
                saying whose. */}
            <Show when={providers().length === 1}>
              <p class="text-13-regular text-text-base">
                This server runs cloud workspaces on <span class="text-text-strong">{provider().label}</span>.
              </p>
            </Show>
            <For each={provider().fields}>
              {(field) => (
                <TextField
                  label={field.label}
                  type={field.secret ? "password" : "text"}
                  value={values()[field.key] ?? ""}
                  placeholder={provider().configured ? "••••••••" : field.label}
                  disabled={busy()}
                  onChange={(value: string) => setValues((current) => ({ ...current, [field.key]: value }))}
                />
              )}
            </For>

            <Show when={provider().configured || saved()}>
              <span class="setup-verified text-12-regular">
                <Icon name="circle-check" size="small" />
                {provider().label} is ready for cloud workspaces
              </span>
            </Show>

            <p class="text-12-regular text-text-weak">
              The key is stored on this machine and pays for your sandboxes directly. Claxedo takes no cut and needs no
              account for this.
            </p>

            <Show when={failure()}>
              {(reason) => (
                <div class="flex items-start gap-2 text-13-regular text-text-weak">
                  <Icon name="warning" size="small" class="mt-0.5 shrink-0" />
                  <div>{reason()}</div>
                </div>
              )}
            </Show>

            <Show when={busy()}>
              <div class="flex items-center gap-2 text-13-regular text-text-base">
                <Spinner />
                Saving your provider key…
              </div>
            </Show>

            {/* The save lives beside the field it commits, not in the footer:
                the footer is pure navigation, so a step's own action never
                competes with Next for the same corner. */}
            <Button class="self-start" size="small" disabled={!ready() || busy()} onClick={() => void save()}>
              Save key
            </Button>
          </div>
        )}
      </Show>
    </div>
  )
}
