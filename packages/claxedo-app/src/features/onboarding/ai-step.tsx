import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { authFetch } from "@/platform/api/api"
import { harnessDisplayLabel } from "@/platform/identity/harness-catalog"
import { errorText } from "./error-text"
import { localHarnessChecks } from "./ai-connect-state"
import {
  AgentHarnessAccounts,
  HarnessProvidersSection,
  MachineAccountsProvider,
  putProviderAuthEntry,
  useMachineAccounts,
  useProviders,
} from "./app-ports"

/** The catalog harnesses the Models page lists provider by provider. */
const CATALOG_HARNESSES = ["pi", "opencode"] as const

/**
 * Step 2: what runs the agent.
 *
 * A desktop is scanned: the Models page's own rows, one per harness on this
 * machine and one provider list per catalog harness, so what the wizard
 * shows is exactly what Settings → Models will show afterwards. The hosted
 * plane has no machine to scan and serves one harness, Pi, whose keys it
 * keeps under its own auth route; that screen is Pi's provider list with a
 * key field per row.
 */
export const AiStep: Component<{
  baseUrl: string
  localExecution: boolean
  /** Whether at least one login can run a turn, re-reported as the rows change. */
  onReady: (ready: boolean) => void
}> = (props) => (
  <Show when={props.localExecution} fallback={<HostedPiKeys baseUrl={props.baseUrl} onReady={props.onReady} />}>
    <MachineAccountsProvider>
      <MachineLogins onReady={props.onReady} />
    </MachineAccountsProvider>
  </Show>
)

const MachineLogins: Component<{ onReady: (ready: boolean) => void }> = (props) => {
  const machine = useMachineAccounts()
  const pi = useProviders("pi")
  const opencode = useProviders("opencode")
  const ready = createMemo(
    () =>
      localHarnessChecks.some((check) => machine.runnable(check))
      || pi.connected().length > 0
      || opencode.connected().length > 0,
  )
  createEffect(() => props.onReady(ready()))

  return (
    <div class="flex flex-col gap-6" data-slot="onboarding-ai-machine">
      <For each={localHarnessChecks}>
        {(check) => <AgentHarnessAccounts harness={check} />}
      </For>
      <For each={CATALOG_HARNESSES}>
        {(harness) => (
          <section class="flex flex-col gap-2" data-harness={harness}>
            <h3 class="text-14-medium text-text-strong">{harnessDisplayLabel(harness)}</h3>
            <HarnessProvidersSection harness={harness} />
          </section>
        )}
      </For>
    </div>
  )
}

/** A Pi provider that signs in through a CLI rather than taking a key. */
const SIGNS_IN_ELSEWHERE: readonly string[] = ["openai-codex"]

const HostedPiKeys: Component<{ baseUrl: string; onReady: (ready: boolean) => void }> = (props) => {
  const providers = useProviders("pi")
  const [open, setOpen] = createSignal<string>()
  const [key, setKey] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const connected = createMemo(() => new Set(providers.connected().map((provider) => provider.id)))
  const rows = createMemo(() => [...providers.all().values()])
  createEffect(() => props.onReady(connected().size > 0))

  const save = async (providerId: string) => {
    const secret = key().trim()
    if (!secret) return
    setSaving(true)
    setFailure(undefined)
    try {
      await putProviderAuthEntry({ serverUrl: props.baseUrl, providerId, harness: "pi", key: secret, request: authFetch })
      await providers.refresh()
      setOpen(undefined)
      setKey("")
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex flex-col gap-2" data-slot="onboarding-ai-hosted">
      <p class="text-13-regular text-text-weak">
        Cloud sandboxes here run Pi. Paste a key for one provider; it is stored on this deployment and handed to every
        sandbox you start.
      </p>
      <Show when={providers.error()}>
        {(message) => (
          <p class="text-12-regular text-icon-warning-base" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={providers.loading() && rows().length === 0}>
        <span class="text-12-regular text-text-weak">Loading providers…</span>
      </Show>
      <ul class="flex flex-col divide-y divide-border-weak-base" data-slot="onboarding-pi-providers">
        <For each={rows()}>
          {(provider) => (
            <li class="flex flex-col gap-2 py-3" data-provider={provider.id} data-connected={connected().has(provider.id)}>
              <div class="flex items-center gap-3">
                <ProviderIcon id={provider.id} class="size-5 shrink-0 icon-strong-base" />
                <span class="min-w-0 flex-1 truncate text-14-medium text-text-strong">{provider.name}</span>
                <Show
                  when={!connected().has(provider.id)}
                  fallback={<span class="text-12-medium text-text-weak">Connected</span>}
                >
                  <Show
                    when={!SIGNS_IN_ELSEWHERE.includes(provider.id)}
                    fallback={<span class="text-12-regular text-text-weak">Signs in from a CLI; no key to paste here</span>}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      onClick={() => {
                        setFailure(undefined)
                        setKey("")
                        setOpen(open() === provider.id ? undefined : provider.id)
                      }}
                    >
                      {open() === provider.id ? "Cancel" : "Connect"}
                    </Button>
                  </Show>
                </Show>
              </div>
              <Show when={open() === provider.id}>
                <form
                  class="flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void save(provider.id)
                  }}
                >
                  <input
                    type="password"
                    value={key()}
                    onInput={(event) => setKey(event.currentTarget.value)}
                    placeholder={`${provider.name} API key`}
                    aria-label={`${provider.name} API key`}
                    autocomplete="off"
                    spellcheck={false}
                    class="h-9 w-full min-w-0 rounded-md border border-border-base bg-surface-inset-base px-2.5 text-13-regular text-text-strong placeholder:text-text-weak/60 focus:outline-none focus:border-border-interactive-base"
                  />
                  <Button type="submit" variant="primary" size="small" disabled={saving() || !key().trim()}>
                    {saving() ? "Saving…" : "Save key"}
                  </Button>
                </form>
                <Show when={failure()}>
                  <p class="text-12-regular text-icon-warning-base" role="alert">
                    {failure()}
                  </p>
                </Show>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
