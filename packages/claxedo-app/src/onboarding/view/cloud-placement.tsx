import { For, Match, Show, Switch } from "solid-js"
import { DrawerSandboxKey, useSandboxKeys, type SandboxKeysLoad, type SandboxKeysStore, type SandboxListing } from "@/accounts"
import { MachineSizeField, type MachineSizeChoice } from "@/cloud"
import { useConnectMachine } from "@/settings"
import { Button, DelayedLoading, Spinner, useDialog } from "@/ui"
import { providerInUse, providerRows } from "../cloud-provider"
import { useOnboardingText } from "../i18n"
import { offersConnectMachine, type ExecutionFacts } from "../model"
import { ChoiceRow } from "./choice-row"

function ProviderChoice(props: { readonly listing: SandboxListing; readonly store: SandboxKeysStore }) {
  const t = useOnboardingText()
  const dialog = useDialog()
  const inUse = () => props.listing.defaultDriver ?? props.listing.managedDriver
  return (
    <div class="flex flex-col gap-2">
      <div role="radiogroup" aria-label={t("onboarding.execution.label")} aria-busy={props.store.activity()?.kind === "choosing"} class="flex flex-col gap-2">
        <For each={providerRows(t, props.listing)}>
          {(row) => <ChoiceRow checked={row.id === inUse()} title={row.title} detail={row.detail} onChoose={() => row.keyed && props.store.choose(row.id)} />}
        </For>
      </div>
      <Show when={props.listing.drivers.length > 0}>
        <Button type="button" variant="ghost" size="small" icon="plus" class="self-start" onClick={() => dialog.show(() => <DrawerSandboxKey drivers={props.listing.drivers} store={props.store} />)}>
          {t("onboarding.cloud.add")}
        </Button>
      </Show>
    </div>
  )
}

function ConnectMachine() {
  const t = useOnboardingText()
  const connect = useConnectMachine()
  return (
    <Button type="button" variant="ghost" size="small" icon="plus" class="self-start" onClick={connect}>
      {t("onboarding.execution.connect")}
    </Button>
  )
}

const failure = (load: SandboxKeysLoad) => (load.kind === "failed" ? load.error : undefined)
const listing = (load: SandboxKeysLoad) => (load.kind === "ready" ? load.listing : undefined)

export function CloudPlacement(props: { readonly facts: ExecutionFacts; readonly size: MachineSizeChoice | undefined }) {
  const t = useOnboardingText()
  const store = useSandboxKeys()
  return (
    <div class="flex flex-col gap-4">
      <Switch>
        <Match when={store.load().kind === "loading"}>
          <DelayedLoading>
            <p class="flex items-center gap-2 py-2 text-12-regular text-text-weak">
              <Spinner class="size-4" />
              <span>{t("onboarding.cloud.loading")}</span>
            </p>
          </DelayedLoading>
        </Match>
        <Match when={failure(store.load())}>
          {(error) => <p class="text-12-regular text-icon-warning-base" role="alert">{t("onboarding.cloud.loadFailed", { reason: error().message })}</p>}
        </Match>
        <Match when={listing(store.load())}>
          {(ready) => (
            <Show when={ready().canManage} fallback={<p class="text-13-regular text-text-weak">{t("onboarding.cloud.fixed", { provider: providerInUse(t, ready()) })}</p>}>
              <ProviderChoice listing={ready()} store={store} />
            </Show>
          )}
        </Match>
      </Switch>
      <Show when={props.size}>{(size) => <MachineSizeField choice={size()} />}</Show>
      <Show when={offersConnectMachine(props.facts)}>
        <ConnectMachine />
      </Show>
    </div>
  )
}
