import { For, Match, Show, Switch } from "solid-js"
import { useAccess } from "@/access"
import { SettingsEmpty, SettingsGroup, SettingsList, SettingsNote, SettingsRow } from "@/settings"
import { Select, useDialog } from "@/ui"
import { useAccountsText } from "../i18n"
import { useSandboxKeys, type SandboxKeysStore, type SandboxListing } from "../sandbox-store"
import { DrawerSandboxKey } from "./sandbox-key-form"
import { SandboxKeyRow } from "./sandbox-key-row"

const LINK = "rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"

function DefaultDriver(props: { readonly listing: SandboxListing; readonly store: SandboxKeysStore }) {
  const t = useAccountsText()
  const keyed = () => props.listing.drivers.filter((driver) => props.listing.keys.some((key) => key.providerId === driver.id))
  return (
    <SettingsRow title={t("settings.sandbox.default.label")} description={t("settings.sandbox.default.description")}>
      <Show
        when={keyed().length > 0}
        fallback={<span class="text-13-regular text-text-weak">{t(props.listing.managedDriver ? "settings.sandbox.default.managed" : "settings.sandbox.default.none")}</span>}
      >
        <Select
          aria-label={t("settings.sandbox.default.label")}
          options={keyed()}
          current={keyed().find((driver) => driver.id === props.listing.defaultDriver)}
          value={(driver) => driver.id}
          label={(driver) => driver.label}
          onSelect={(driver) => driver && props.store.choose(driver.id)}
          appearance="inline"
        />
      </Show>
    </SettingsRow>
  )
}

function SandboxKeys(props: { readonly listing: SandboxListing; readonly store: SandboxKeysStore }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const label = (providerId: string) => props.listing.drivers.find((driver) => driver.id === providerId)?.label ?? providerId
  const add = (
    <button type="button" class={LINK} onClick={() => dialog.show(() => <DrawerSandboxKey drivers={props.listing.drivers} store={props.store} />)}>{t("settings.sandbox.add")}</button>
  )
  return (
    <SettingsGroup title={t("settings.sandbox.title")} description={t("settings.sandbox.description")} action={add}>
      <SettingsList>
        <DefaultDriver listing={props.listing} store={props.store} />
        <For each={props.listing.keys}>{(account) => <SandboxKeyRow account={account} label={label(account.providerId)} store={props.store} />}</For>
      </SettingsList>
      <Show when={props.listing.keys.length === 0}>
        <SettingsEmpty>
          <span>{t("settings.sandbox.empty")}</span>
        </SettingsEmpty>
      </Show>
    </SettingsGroup>
  )
}

export function SandboxSection() {
  const t = useAccountsText()
  const access = useAccess()
  const store = useSandboxKeys()
  const listing = () => {
    const load = store.load()
    return load.kind === "ready" && access.can("sandbox.manage", { canManageSandboxKeys: load.listing.canManage }) ? load.listing : undefined
  }
  const failure = () => {
    const load = store.load()
    return load.kind === "failed" ? load.error : undefined
  }
  return (
    <Switch>
      <Match when={failure()}>{(error) => <SettingsNote tone="danger">{t("settings.sandbox.loadFailed", { reason: error().message })}</SettingsNote>}</Match>
      <Match when={listing()}>{(ready) => <SandboxKeys listing={ready()} store={store} />}</Match>
    </Switch>
  )
}
