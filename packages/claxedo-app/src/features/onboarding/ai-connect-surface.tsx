import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show, createMemo, createSignal, type Component } from "solid-js"
import { queryClient } from "@/platform/query/query-client"
import {
  connectAIKey,
  discoverAIConnections,
  saveDiscoveredAIConnections,
  type AIConnectRequest,
  type AIVerificationResult,
} from "./ai-connect-api"
import {
  aiConnectFailureCopy,
  aiConnectTransition,
  initialAIConnectState,
  type AIConnectEvent,
  type AIConnectState,
} from "./ai-connect-state"
import type { OnboardingFunnelEvent } from "./funnel"

const providers = [
  { id: "anthropic", name: "Anthropic" },
  { id: "openai", name: "OpenAI" },
  { id: "openrouter", name: "OpenRouter" },
] as const

export type AIConnectSurfaceProps = {
  localDiscovery: boolean
  serverUrl?: string
  defaultScope?: "local" | "shared"
  request?: AIConnectRequest
  deviceLoginConfigured?: boolean
  onProviderConnect?: (providerId: string) => void
  invalidateQueries?: () => Promise<void>
  onConnected?: (results: AIVerificationResult[]) => void | Promise<void>
  emit?: (event: Extract<OnboardingFunnelEvent, { name: "provider_connected" | "step_verify_failed" }>) => void
}

export const AIConnectSurface: Component<AIConnectSurfaceProps> = (props) => {
  const [state, setState] = createSignal(initialAIConnectState())
  const [scope, setScope] = createSignal<"local" | "shared">(props.defaultScope ?? (props.localDiscovery ? "local" : "shared"))
  const [providerId, setProviderId] = createSignal<(typeof providers)[number]["id"]>("anthropic")
  const [apiKey, setApiKey] = createSignal("")
  const provider = createMemo(() => providers.find((item) => item.id === providerId()) ?? providers[0])
  const busy = createMemo(() => state().phase === "discovering" || state().phase === "saving" || state().phase === "verifying")
  const preview = createMemo<Extract<AIConnectState, { phase: "preview" }> | undefined>(() => {
    const current = state()
    return current.phase === "preview" ? current : undefined
  })
  const notWorking = createMemo<Extract<AIConnectState, { phase: "not-working" }> | undefined>(() => {
    const current = state()
    return current.phase === "not-working" ? current : undefined
  })
  const error = createMemo<Extract<AIConnectState, { phase: "error" }> | undefined>(() => {
    const current = state()
    return current.phase === "error" ? current : undefined
  })

  const transition = (event: AIConnectEvent) => setState((current) => aiConnectTransition(current, event))
  const invalidate = () => props.invalidateQueries?.() ?? invalidateAIConnectQueries()

  async function discover() {
    transition({ type: "discovery-started" })
    await discoverAIConnections({ serverUrl: props.serverUrl, request: props.request })
      .then((result) => transition({
        type: "discovery-succeeded",
        discoveryId: result.discoveryId,
        items: result.items,
      }))
      .catch((error: unknown) => transition({ type: "failed", message: errorMessage(error) }))
  }

  async function saveDiscovered() {
    const preview = state()
    if (preview.phase !== "preview") return
    const selected = preview.items.filter((item) => item.selected && !item.alreadyConnected)
    if (selected.length === 0) return
    transition({ type: "save-started" })
    await saveDiscoveredAIConnections({
      serverUrl: props.serverUrl,
      discoveryId: preview.discoveryId,
      items: selected.map((item) => ({ providerId: item.providerId, accountId: item.accountId, scope: scope() })),
      request: props.request,
    })
      .then(complete)
      .catch((error: unknown) => transition({ type: "failed", message: errorMessage(error) }))
  }

  async function saveKey(event: SubmitEvent) {
    event.preventDefault()
    const value = apiKey().trim()
    if (!value) {
      transition({ type: "failed", message: "Enter an API key before saving." })
      return
    }
    transition({ type: "save-started" })
    await connectAIKey({
      serverUrl: props.serverUrl,
      providerId: provider().id,
      providerName: provider().name,
      apiKey: value,
      scope: scope(),
      request: props.request,
    })
      .then((result) => complete([result]))
      .catch((error: unknown) => transition({ type: "failed", message: errorMessage(error) }))
  }

  async function complete(results: AIVerificationResult[]) {
    await invalidate()
    const failed = results.find((result) => result.result !== "ok")
    const current = failed ?? results[0]
    if (!current) {
      transition({ type: "failed", message: "No saved credential was available to verify." })
      return
    }
    transition({ type: "verification-started", providerId: current.providerId })
    transition({ type: "verification-result", result: current.result })
    if (failed) {
      props.emit?.({ name: "step_verify_failed", step: "ai", class: failed.result })
      return
    }
    results.forEach((result) => props.emit?.({ name: "provider_connected", provider: result.providerId }))
    await props.onConnected?.(results)
  }

  return (
    <div class="flex flex-col gap-5" data-component="ai-connect-surface">
      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Show when={props.localDiscovery}>
          <section class="flex min-h-40 flex-col gap-3 rounded-md border border-border-weak-base p-4">
            <div>
              <h3 class="text-14-medium text-text-strong">Detect on this machine</h3>
              <p class="mt-1 text-12-regular text-text-weak">
                Find Claude Code and Codex CLI credentials without saving anything yet.
              </p>
            </div>
            <p class="text-12-regular text-text-base">
              opencode discovery works on macOS and Linux, but not Windows. Cursor credentials aren't discoverable yet.
            </p>
            <Button class="mt-auto self-start" variant="secondary" disabled={busy()} onClick={() => void discover()}>
              Detect credentials
            </Button>
          </section>
        </Show>

        <Show when={!props.localDiscovery}>
          <section class="flex min-h-40 flex-col gap-3 rounded-md border border-border-weak-base p-4">
            <div>
              <h3 class="text-14-medium text-text-strong">Provider sign-in</h3>
              <p class="mt-1 text-12-regular text-text-weak">Use browser sign-in when your provider offers it.</p>
            </div>
            <div class="mt-auto flex flex-col items-start gap-2">
              <Button variant="secondary" disabled={!props.onProviderConnect} onClick={() => props.onProviderConnect?.("openai")}>
                See OpenAI sign-in options
              </Button>
              <Button variant="secondary" disabled={!props.onProviderConnect} onClick={() => props.onProviderConnect?.("anthropic")}>
                See Anthropic sign-in options
              </Button>
            </div>
          </section>

          <section class="flex min-h-40 flex-col gap-3 rounded-md border border-border-weak-base p-4">
            <div>
              <h3 class="text-14-medium text-text-strong">Connect from terminal</h3>
              <p class="mt-1 text-12-regular text-text-weak">Push an existing subscription connection without putting it in the browser.</p>
            </div>
            <TextField label="Terminal command" value="npx claxedo connect claude" readOnly copyable />
            <Show
              when={props.deviceLoginConfigured}
              fallback={<p class="mt-auto text-12-regular text-icon-warning-base">Coming soon on this server. Use the desktop app or enter an API key.</p>}
            >
              <p class="mt-auto text-12-regular text-text-weak">Run the command in your terminal, then return here to verify the connection.</p>
            </Show>
          </section>
        </Show>

        <section class="flex min-h-40 flex-col gap-3 rounded-md border border-border-weak-base p-4">
          <div>
            <h3 class="text-14-medium text-text-strong">Enter an API key</h3>
            <p class="mt-1 text-12-regular text-text-weak">Connect directly with a key from your provider.</p>
          </div>
          <div class="flex flex-wrap gap-1.5" aria-label="AI provider">
            <For each={providers}>
              {(item) => (
                <Button
                  size="small"
                  variant={providerId() === item.id ? "primary" : "secondary"}
                  aria-pressed={providerId() === item.id}
                  onClick={() => setProviderId(item.id)}
                >
                  <ProviderIcon id={item.id} class="size-4" />
                  {item.name}
                </Button>
              )}
            </For>
          </div>
          <form class="mt-auto flex flex-col gap-3" onSubmit={(event) => void saveKey(event)}>
            <TextField
              type="password"
              label={`${provider().name} API key`}
              value={apiKey()}
              onChange={setApiKey}
              disabled={busy()}
            />
            <Button class="self-start" type="submit" disabled={busy()}>Save and verify</Button>
          </form>
        </section>
      </div>

      <Show when={props.localDiscovery || props.defaultScope === "local"}>
        <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-3">
          <div class="text-12-medium text-text-strong">Available to</div>
          <div class="flex flex-wrap gap-2">
            <Button size="small" variant={scope() === "local" ? "primary" : "secondary"} onClick={() => setScope("local")}>This machine only</Button>
            <Button size="small" variant={scope() === "shared" ? "primary" : "secondary"} onClick={() => setScope("shared")}>My cloud workspaces</Button>
          </div>
          <p class="text-12-regular text-text-weak">
            {scope() === "local"
              ? "The credential stays available only to this machine."
              : "The credential may run in your cloud workspaces. Using subscription credentials there is your choice and may be subject to provider terms."}
          </p>
        </div>
      </Show>

      <Show when={state().phase === "discovering"}>
        <div class="flex items-center gap-2 text-13-regular text-text-base"><Spinner />Scanning this machine…</div>
      </Show>
      <Show when={preview()}>
        {(preview) => (
          <div class="flex flex-col gap-3 rounded-md border border-border-weak-base p-3">
            <div>
              <div class="text-13-medium text-text-strong">Choose what to save</div>
              <div class="text-12-regular text-text-weak">Nothing leaves this machine until you save the selected connections.</div>
            </div>
            <Show when={preview().items.length > 0} fallback={<div class="text-12-regular text-text-weak">No supported credentials were found.</div>}>
              <For each={preview().items}>
                {(item) => (
                  <label class="flex items-start gap-3 rounded-md border border-border-weak-base px-3 py-2">
                    <input
                      type="checkbox"
                      class="mt-1"
                      checked={item.selected}
                      disabled={item.alreadyConnected}
                      aria-label={`${item.label} from ${item.origin}`}
                      onChange={(event) => transition({ type: "selection-changed", selectionId: item.selectionId, selected: event.currentTarget.checked })}
                    />
                    <span class="flex min-w-0 flex-col">
                      <span class="text-13-medium text-text-strong">{item.label}</span>
                      <span class="text-12-regular text-text-weak">{item.accountId ? `${item.accountId} · ` : ""}{item.origin}</span>
                      <Show when={item.alreadyConnected}><span class="text-12-regular text-icon-success-base">Already connected</span></Show>
                    </span>
                  </label>
                )}
              </For>
              <Button
                class="self-start"
                disabled={!preview().items.some((item) => item.selected && !item.alreadyConnected)}
                onClick={() => void saveDiscovered()}
              >
                Save selected
              </Button>
            </Show>
          </div>
        )}
      </Show>
      <Show when={state().phase === "saving" || state().phase === "verifying"}>
        <div class="flex items-center gap-2 text-13-regular text-text-base"><Spinner />Saving and verifying with the provider…</div>
      </Show>
      <Show when={state().phase === "connected"}>
        <div class="flex items-center gap-2 rounded-md border border-border-success-base bg-surface-success-base px-3 py-2 text-13-medium text-text-on-success-base">
          <Icon name="circle-check" size="small" />Connected and verified
        </div>
      </Show>
      <Show when={notWorking()}>
        {(failed) => (
          <div class="flex items-start gap-2 rounded-md border border-border-warning-base bg-surface-warning-base px-3 py-2 text-text-on-warning-base">
            <Icon name="warning" size="small" class="mt-0.5 shrink-0" />
            <div class="flex flex-col gap-1">
              <div class="text-13-medium">Connected, not working</div>
              <div class="text-12-regular">{aiConnectFailureCopy(failed().result)}</div>
              <Button size="small" variant="ghost" class="self-start" onClick={() => transition({ type: "reset" })}>Fix connection</Button>
            </div>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(failed) => (
          <div class="flex items-start gap-2 rounded-md border border-border-warning-base bg-surface-warning-base px-3 py-2 text-text-on-warning-base">
            <Icon name="warning" size="small" class="mt-0.5 shrink-0" />
            <div class="text-12-regular">{failed().message}</div>
          </div>
        )}
      </Show>
    </div>
  )
}

export async function invalidateAIConnectQueries() {
  await queryClient.invalidateQueries({
    predicate: (query) => query.queryKey.includes("credentials") || query.queryKey[2] === "providers",
  })
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
