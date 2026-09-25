import { Spinner } from "@/ui"
import { createEffect, createSignal, For, Show } from "solid-js"
import { AgentHarnessAccounts, createHarnessProviders, harnesses, HarnessProvidersSection, useAccounts, type HarnessProviders } from "@/accounts"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import { hasManagedProviderCredentials, NATIVE_HARNESS_IDS } from "@/lib/harness-selection"
import { useOnboardingText } from "../i18n"

const CATALOG_HARNESSES: readonly string[] = NATIVE_HARNESS_IDS.filter(hasManagedProviderCredentials)

const HOSTED_HARNESSES: readonly string[] = ["pi"]

function useCatalogs(ids: readonly string[]) {
  const catalogs = ids.map((id) => createHarnessProviders(() => id))
  return { catalogs, connected: () => catalogs.some((catalog) => catalog.connected()) }
}

function CatalogSection(props: { readonly providers: HarnessProviders; readonly class?: string }) {
  return (
    <section class={`flex flex-col gap-2 ${props.class ?? ""}`} data-harness={props.providers.harness()}>
      <h3 class="text-14-medium text-text-strong">{harnessDisplayLabel(props.providers.harness())}</h3>
      <HarnessProvidersSection providers={props.providers} />
    </section>
  )
}

function Scanning() {
  const t = useOnboardingText()
  return (
    <p class="flex items-center gap-2 py-2 text-12-regular text-text-weak">
      <Spinner class="size-4" />
      <span>{t("onboarding.ai.scanning")}</span>
    </p>
  )
}

function CatalogChoice(props: { readonly catalogs: readonly HarnessProviders[]; readonly chosen: string | undefined; readonly onChoose: (id: string) => void }) {
  const t = useOnboardingText()
  return (
    <span class="flex items-center gap-1.5 text-11-medium text-text-weak">
      <span>{t("onboarding.ai.catalog")}</span>
      <For each={props.catalogs}>
        {(entry, position) => (
          <>
            <Show when={position() > 0}>
              <span aria-hidden="true">·</span>
            </Show>
            <button
              type="button"
              aria-pressed={props.chosen === entry.harness()}
              data-harness-choice={entry.harness()}
              class={`underline-offset-2 hover:text-text-strong hover:underline focus-visible:underline focus-visible:outline-none ${props.chosen === entry.harness() ? "text-text-strong underline" : ""}`}
              onClick={() => props.onChoose(entry.harness())}
            >
              {harnessDisplayLabel(entry.harness())}
            </button>
          </>
        )}
      </For>
    </span>
  )
}

function MachineLogins(props: { readonly onReady: (ready: boolean) => void }) {
  const t = useOnboardingText()
  const accounts = useAccounts()
  const { catalogs, connected } = useCatalogs(CATALOG_HARNESSES)
  const [chosen, setChosen] = createSignal<string>()
  createEffect(() => props.onReady(accounts.runnable() || connected()))
  const chosenCatalog = () => catalogs.find((entry) => entry.harness() === chosen())
  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span class="text-12-medium text-text-weak">{t("onboarding.ai.logins")}</span>
        <CatalogChoice catalogs={catalogs} chosen={chosen()} onChoose={(id) => setChosen(chosen() === id ? undefined : id)} />
      </div>
      <Show when={accounts.opened()} fallback={<Scanning />}>
        <div class="flex flex-col gap-6">
          <For each={harnesses}>{(harness) => <AgentHarnessAccounts harness={harness} accounts={accounts} />}</For>
        </div>
      </Show>
      <Show when={chosenCatalog()}>{(providers) => <CatalogSection providers={providers()} class="border-t border-border-weak-base pt-4" />}</Show>
    </div>
  )
}

function HostedLogins(props: { readonly onReady: (ready: boolean) => void }) {
  const { catalogs, connected } = useCatalogs(HOSTED_HARNESSES)
  createEffect(() => props.onReady(connected()))
  return (
    <div class="flex flex-col gap-6">
      <For each={catalogs}>{(providers) => <CatalogSection providers={providers} />}</For>
    </div>
  )
}

export function AiStep(props: { readonly localExecution: boolean; readonly onReady: (ready: boolean) => void }) {
  return (
    <Show when={props.localExecution} fallback={<HostedLogins onReady={props.onReady} />}>
      <MachineLogins onReady={props.onReady} />
    </Show>
  )
}
