import { createEffect, createMemo, createSignal, For, Show, type Component } from "solid-js"
import { Spinner } from "@opencode-ai/ui/spinner"
import { harnessDisplayLabel } from "@/platform/identity/harness-catalog"
import { hasManagedProviderCredentials, NATIVE_HARNESS_IDS, type NativeHarnessId } from "@/platform/identity/harness-selection"
import { localHarnessChecks } from "./ai-connect-state"
import {
  AgentHarnessAccounts,
  HarnessProvidersSection,
  MachineAccountsProvider,
  useMachineAccounts,
  useProviders,
} from "./app-ports"

/** The harnesses connected provider by provider, in catalog order. */
const CATALOG_HARNESSES: readonly NativeHarnessId[] = NATIVE_HARNESS_IDS.filter(hasManagedProviderCredentials)

/**
 * The hosted plane serves one harness: its catalog and auth routes answer for
 * `nativeHarness=pi` and refuse the rest.
 */
const HOSTED_HARNESSES: readonly NativeHarnessId[] = ["pi"]

/**
 * Step 2: what runs the agent, drawn with the Models page's own rows so what
 * the wizard shows is exactly what Settings → Models will show afterwards.
 *
 * A desktop is scanned for the logins its harnesses already hold, and a
 * catalog harness's provider list is there for whoever brings a key instead.
 * The hosted plane has no machine to scan, so its one harness's provider list
 * is the whole step; the same rows store the key under the plane's own auth
 * route.
 */
export const AiStep: Component<{
  localExecution: boolean
  /** Whether at least one login can run a turn, re-reported as the rows change. */
  onReady: (ready: boolean) => void
}> = (props) => (
  <Show when={props.localExecution} fallback={<HostedLogins onReady={props.onReady} />}>
    <MachineAccountsProvider>
      <MachineLogins onReady={props.onReady} />
    </MachineAccountsProvider>
  </Show>
)

function useCatalogs(harnesses: readonly NativeHarnessId[]) {
  const catalogs = harnesses.map((harness) => ({ harness, providers: useProviders(harness) }))
  return { catalogs, connected: () => catalogs.some((entry) => entry.providers.connected().length > 0) }
}

const CatalogSection: Component<{ harness: NativeHarnessId; class?: string }> = (props) => (
  <section class={`flex flex-col gap-2 ${props.class ?? ""}`} data-harness={props.harness}>
    <h3 class="text-14-medium text-text-strong">{harnessDisplayLabel(props.harness)}</h3>
    <HarnessProvidersSection harness={props.harness} />
  </section>
)

const HostedLogins: Component<{ onReady: (ready: boolean) => void }> = (props) => {
  const { catalogs, connected } = useCatalogs(HOSTED_HARNESSES)
  createEffect(() => props.onReady(connected()))
  return (
    <div class="flex flex-col gap-6" data-slot="onboarding-ai-logins">
      <For each={catalogs}>{(entry) => <CatalogSection harness={entry.harness} />}</For>
    </div>
  )
}

const MachineLogins: Component<{ onReady: (ready: boolean) => void }> = (props) => {
  const machine = useMachineAccounts()
  const { catalogs, connected } = useCatalogs(CATALOG_HARNESSES)
  const [chosen, setChosen] = createSignal<NativeHarnessId>()
  const ready = createMemo(() => localHarnessChecks.some((check) => machine.runnable(check)) || connected())
  createEffect(() => props.onReady(ready()))
  const choose = (harness: NativeHarnessId) => setChosen(chosen() === harness ? undefined : harness)

  return (
    <div class="flex flex-col gap-4" data-slot="onboarding-ai-logins">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span class="text-12-medium text-text-weak">Logins on this machine</span>
        <span class="flex items-center gap-1.5 text-11-medium text-text-weak" data-slot="onboarding-ai-catalog">
          <span>Or connect a provider for</span>
          <For each={catalogs}>
            {(entry, position) => (
              <>
                <Show when={position() > 0}>
                  <span aria-hidden="true">·</span>
                </Show>
                <button
                  type="button"
                  aria-pressed={chosen() === entry.harness}
                  data-harness-choice={entry.harness}
                  class={`underline-offset-2 hover:text-text-strong hover:underline focus-visible:underline focus-visible:outline-none ${
                    chosen() === entry.harness ? "text-text-strong underline" : ""
                  }`}
                  onClick={() => choose(entry.harness)}
                >
                  {harnessDisplayLabel(entry.harness)}
                </button>
              </>
            )}
          </For>
        </span>
      </div>
      <Show
        when={machine.opened()}
        fallback={
          <p class="flex items-center gap-2 py-2 text-12-regular text-text-weak" data-slot="onboarding-ai-scanning">
            <Spinner class="size-4" />
            <span>Scanning this machine for logins…</span>
          </p>
        }
      >
        <div class="flex flex-col gap-6">
          <For each={localHarnessChecks}>{(check) => <AgentHarnessAccounts harness={check} />}</For>
        </div>
      </Show>
      <Show when={chosen()}>
        {(harness) => <CatalogSection harness={harness()} class="border-t border-border-weak-base pt-4" />}
      </Show>
    </div>
  )
}
