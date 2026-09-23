import { createEffect, createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { TextField } from "@opencode-ai/ui/text-field"
import { SandboxDriverLogo, workspaceSandboxDriverAuthUrl } from "./app-ports"
import {
  canSaveSandboxProvider,
  readSandboxProviderCatalog,
  saveSandboxProviderKey,
  type SandboxProviderOption,
  type SandboxProviderVerification,
} from "./sandbox-provider-api"

export type ExecutionChoice = "local" | "cloud" | "connected"

/** Mints the single-use token, on a machine that is already signed in. */
const INVITE_COMMAND = "claxedo host invite --name build-box --root ~/code"
/** Run on the machine being added, with the token the invite printed. */
const CONNECT_COMMAND = "claxedo connect --token-file ./invite.txt --install-service"

/**
 * Step 3: where the work runs.
 *
 * A desktop can run it here, so that row is preselected and Finish is open
 * from the start; the cloud row is offered so a user who wants a sandbox on
 * day one is not sent to Settings to find it. The hosted plane has no "here":
 * its cloud row is the deployment's own sandbox, which needs no key of the
 * user's, and its machine row cannot yet be finished (nothing today can send
 * a repository to a machine you connect), so the row says so and leaves
 * Finish to the cloud row.
 */
export const ExecutionStep: Component<{
  baseUrl: string
  localExecution: boolean
  choice: ExecutionChoice
  onChoice: (choice: ExecutionChoice) => void
  /** Whether the chosen row is in a state Finish can act on. */
  onReady: (ready: boolean) => void
}> = (props) => {
  const [cloudReady, setCloudReady] = createSignal(!props.localExecution)
  const ready = createMemo(() => {
    if (props.choice === "local") return true
    if (props.choice === "cloud") return cloudReady()
    return props.localExecution
  })
  createEffect(() => props.onReady(ready()))

  const rows = createMemo<Array<{ id: ExecutionChoice; title: string; detail: string }>>(() => [
    ...(props.localExecution
      ? [{ id: "local" as const, title: "Just this machine", detail: "Sessions run on this computer, in the project's folder." }]
      : []),
    {
      id: "cloud" as const,
      title: "A cloud sandbox",
      detail: props.localExecution
        ? "Sessions run in a sandbox you pay a provider for; your machine can be off."
        : "Sessions run in a sandbox this deployment provides.",
    },
    { id: "connected" as const, title: "Another machine", detail: "A computer you connect with the Claxedo CLI serves the work." },
  ])

  return (
    <div class="flex flex-col gap-4" data-slot="onboarding-execution">
      <div role="radiogroup" aria-label="Where work runs" class="flex flex-col gap-2">
        <For each={rows()}>
          {(row) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.choice === row.id}
              data-choice={row.id}
              class="flex flex-col items-start gap-0.5 rounded-lg border border-border-base px-3 py-2.5 text-left transition-colors hover:border-border-interactive-base focus-visible:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active"
              onClick={() => props.onChoice(row.id)}
            >
              <span class="text-14-medium text-text-strong">{row.title}</span>
              <span class="text-12-regular text-text-weak">{row.detail}</span>
            </button>
          )}
        </For>
      </div>

      <Show when={props.choice === "cloud"}>
        <Show
          when={props.localExecution}
          fallback={
            <p class="text-13-regular text-text-weak" data-slot="onboarding-cloud-hosted">
              The sandbox is this deployment's; there is nothing to configure here.
            </p>
          }
        >
          <SandboxProviderKey baseUrl={props.baseUrl} onReady={setCloudReady} />
        </Show>
      </Show>

      <Show when={props.choice === "connected"}>
        <div class="flex flex-col gap-3" data-slot="onboarding-machine">
          <p class="text-13-regular text-text-weak">
            Connecting a machine takes two commands: one here, one on that machine.
          </p>
          <TextField label="On a signed-in machine" value={INVITE_COMMAND} readOnly copyable />
          <TextField label="On the machine being added" value={CONNECT_COMMAND} readOnly copyable />
          <p class="text-12-regular text-text-weak">
            <Show
              when={props.localExecution}
              fallback="Nothing can send this repository to a machine you connect yet, so pick the cloud sandbox to start; a connected machine's own folders appear as projects once it serves them."
            >
              Machines you connect appear in Settings → Machines. This project opens on this computer for now.
            </Show>
          </p>
        </div>
      </Show>
    </div>
  )
}

/**
 * The provider catalog, a key for the chosen one, and the provider's own
 * verdict on it. `working` and `unknown` (a provider whose control plane
 * cannot be asked) count as done; `broken` does not.
 */
const SandboxProviderKey: Component<{ baseUrl: string; onReady: (ready: boolean) => void }> = (props) => {
  const [catalog, { mutate }] = createResource(() => readSandboxProviderCatalog({ baseUrl: props.baseUrl }))
  const [picked, setPicked] = createSignal<string>()
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [saved, setSaved] = createSignal<SandboxProviderVerification>()

  const providers = () => catalog()?.providers ?? []
  const selected = createMemo<SandboxProviderOption | undefined>(() => {
    const id = picked()
    if (id) return providers().find((provider) => provider.id === id)
    return providers().find((provider) => provider.configured) ?? providers()[0]
  })
  const verdict = createMemo(() => saved() ?? selected()?.verification)
  const done = createMemo(() => {
    const provider = selected()
    if (!provider) return false
    const state = verdict()?.state
    if (state) return state !== "broken"
    return provider.configured
  })
  createEffect(() => props.onReady(done()))

  const save = async () => {
    const provider = selected()
    if (!provider || !canSaveSandboxProvider(provider, values())) return
    setBusy(true)
    setFailure(undefined)
    const outcome = await saveSandboxProviderKey({
      baseUrl: props.baseUrl,
      providerId: provider.id,
      values: Object.fromEntries(provider.fields.map((field) => [field.key, values()[field.key] ?? ""])),
      authUrl: workspaceSandboxDriverAuthUrl,
    })
    setBusy(false)
    if (!outcome.ok) {
      setFailure(outcome.reason)
      return
    }
    mutate(outcome.catalog)
    setSaved(outcome.verification ?? { state: "unknown" })
    setValues({})
  }

  return (
    <div class="flex flex-col gap-3" data-slot="onboarding-sandbox-key">
      <Show when={catalog.loading}>
        <span class="text-12-regular text-text-weak">Loading sandbox providers…</span>
      </Show>
      <Show when={catalog.error}>
        <p class="text-12-regular text-icon-warning-base" role="alert">
          This server can't manage sandbox provider keys. Add the key where the server runs.
        </p>
      </Show>
      <Show when={providers().length > 0}>
        <div role="radiogroup" aria-label="Sandbox provider" class="flex flex-wrap gap-2">
          <For each={providers()}>
            {(provider) => (
              <button
                type="button"
                role="radio"
                aria-checked={selected()?.id === provider.id}
                data-provider={provider.id}
                class="flex items-center gap-2 rounded-md border border-border-base px-2.5 py-1.5 text-13-regular text-text-strong hover:border-border-interactive-base focus-visible:outline-none aria-checked:border-border-interactive-base aria-checked:bg-surface-raised-base-active"
                onClick={() => {
                  setPicked(provider.id)
                  setSaved(undefined)
                  setFailure(undefined)
                }}
              >
                <SandboxDriverLogo id={provider.id} label={provider.label} class="size-4 shrink-0" />
                <span>{provider.label}</span>
                <Show when={provider.configured}>
                  <span class="text-11-medium text-text-weak">key saved</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={selected()}>
        {(provider) => (
          <form
            class="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <For each={provider().fields}>
              {(field) => (
                <label class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-weak">{field.label}</span>
                  <input
                    type={field.secret ? "password" : "text"}
                    value={values()[field.key] ?? ""}
                    onInput={(event) => setValues({ ...values(), [field.key]: event.currentTarget.value })}
                    aria-label={field.label}
                    autocomplete="off"
                    spellcheck={false}
                    class="h-9 w-full min-w-0 rounded-md border border-border-base bg-surface-inset-base px-2.5 text-13-regular text-text-strong focus:outline-none focus:border-border-interactive-base"
                  />
                </label>
              )}
            </For>
            <div class="flex items-center gap-3">
              <Button
                type="submit"
                variant="secondary"
                size="small"
                disabled={busy() || !canSaveSandboxProvider(provider(), values())}
              >
                {busy() ? "Checking…" : provider().configured ? "Replace key" : "Save key"}
              </Button>
              <Show when={verdict()}>
                {(state) => (
                  <span class="text-12-regular text-text-weak" data-slot="onboarding-sandbox-verdict" data-state={state().state}>
                    {state().state === "working"
                      ? `${provider().label} answered; the key works.`
                      : state().state === "broken"
                        ? state().reason ?? `${provider().label} rejected the key.`
                        : state().reason ?? `${provider().label} could not be checked; the key is saved.`}
                  </span>
                )}
              </Show>
            </div>
            <Show when={failure()}>
              <p class="text-12-regular text-icon-warning-base" role="alert">
                {failure()}
              </p>
            </Show>
          </form>
        )}
      </Show>
    </div>
  )
}
