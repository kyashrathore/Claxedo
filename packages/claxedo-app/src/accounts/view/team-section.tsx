import { For, Match, Show, Switch } from "solid-js"
import { SignedOutNotice, useAccess } from "@/access"
import type { AccountSources } from "@/server"
import { SettingsEmpty, SettingsIntro, SettingsList, SettingsNote } from "@/settings"
import { useDialog } from "@/ui"
import { useAccountsText } from "../i18n"
import { accountLabel, teamVendorLabel } from "../model"
import { useTeamAccounts, type TeamAccountsStore } from "../team-store"
import { KeyRow } from "./key-row"
import { DrawerTeamAccount } from "./team-account-form"

const LINK = "rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"

function TeamAccounts(props: { readonly sources: AccountSources; readonly store: TeamAccountsStore; readonly manages: boolean }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const add = (
    <button type="button" class={LINK} data-action="settings-team-add" onClick={() => dialog.show(() => <DrawerTeamAccount store={props.store} />)}>
      {t("settings.team.add")}
    </button>
  )
  return (
    <>
      <SettingsIntro description={t("settings.team.description")} {...(props.manages ? { action: add } : {})} />
      <Show when={!props.manages}>
        <SettingsNote>{t("settings.team.managedByAdmins")}</SettingsNote>
      </Show>
      <Show
        when={props.sources.org.length > 0}
        fallback={<SettingsEmpty><span>{t("settings.team.empty")}</span></SettingsEmpty>}
      >
        <SettingsList>
          <For each={props.sources.org}>
            {(account) => (
              <KeyRow
                account={account}
                label={accountLabel(account)}
                detail={teamVendorLabel(account.providerId)}
                store={props.store}
                readOnly={!props.manages}
              />
            )}
          </For>
        </SettingsList>
      </Show>
    </>
  )
}

function SignedInTeamSection() {
  const t = useAccountsText()
  const access = useAccess()
  const store = useTeamAccounts()
  const ready = () => {
    const load = store.load()
    return load.kind === "ready" ? load.sources : undefined
  }
  const failure = () => {
    const load = store.load()
    return load.kind === "failed" ? load.error : undefined
  }
  return (
    <Switch>
      <Match when={failure()}>{(error) => <SettingsNote tone="danger">{t("settings.team.loadFailed", { reason: error().message })}</SettingsNote>}</Match>
      <Match when={ready()}>{(sources) => <TeamAccounts sources={sources()} store={store} manages={access.can("accounts.manageOrg", sources())} />}</Match>
    </Switch>
  )
}

export function TeamSection() {
  const t = useAccountsText()
  const access = useAccess()
  return (
    <div class="settings-body">
      <Show when={access.signedIn()} fallback={<><SettingsIntro description={t("settings.team.description")} /><SignedOutNotice /></>}>
        <SignedInTeamSection />
      </Show>
    </div>
  )
}
