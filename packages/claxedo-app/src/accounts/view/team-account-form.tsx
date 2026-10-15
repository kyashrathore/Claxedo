import { createSignal } from "solid-js"
import { Field, FormDrawer, Select, TextField, useDialog } from "@/ui"
import { useAccountsText } from "../i18n"
import { TEAM_VENDORS } from "../model"
import type { TeamAccountsStore } from "../team-store"

export function DrawerTeamAccount(props: { readonly store: TeamAccountsStore }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const [vendor, setVendor] = createSignal(TEAM_VENDORS[0])
  const [label, setLabel] = createSignal("")
  const [secret, setSecret] = createSignal("")
  const [missing, setMissing] = createSignal(false)
  const submit = async () => {
    const empty = !secret().trim()
    setMissing(empty)
    if (empty) return
    if (await props.store.save(vendor().id, secret(), label())) dialog.close()
  }
  return (
    <FormDrawer
      title={t("settings.team.add.title")}
      description={t("settings.team.add.description")}
      submitLabel={t("settings.team.add.save")}
      busyLabel={t("settings.team.add.saving")}
      cancelLabel={t("common.cancel")}
      busy={props.store.activity()?.kind === "saving"}
      error={missing() ? t("settings.team.add.required") : undefined}
      onSubmit={() => void submit()}
      onCancel={() => dialog.close()}
    >
      <Field>
        <Field.Label>{t("settings.team.add.vendor")}</Field.Label>
        <Select
          aria-label={t("settings.team.add.vendor")}
          options={[...TEAM_VENDORS]}
          current={vendor()}
          value={(option) => option.id}
          label={(option) => option.label}
          onSelect={(option) => option && setVendor(option)}
        />
      </Field>
      <TextField autocomplete="off" label={t("settings.team.add.label")} name="label" value={label()} onChange={setLabel} />
      <TextField type="password" autocomplete="off" label={t("settings.team.add.key")} name="api_key" value={secret()} onChange={setSecret} />
    </FormDrawer>
  )
}
