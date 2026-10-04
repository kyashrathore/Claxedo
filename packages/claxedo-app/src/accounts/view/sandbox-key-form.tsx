import { createSignal, For } from "solid-js"
import { createStore } from "solid-js/store"
import type { SandboxDriverOption } from "@/server"
import { Field, FormDrawer, Select, TextField, useDialog } from "@/ui"
import { useAccountsText } from "../i18n"
import type { SandboxKeysStore } from "../sandbox-store"

export function DrawerSandboxKey(props: { readonly drivers: readonly SandboxDriverOption[]; readonly store: SandboxKeysStore }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const [driverId, setDriverId] = createSignal(props.drivers[0]?.id)
  const [values, setValues] = createStore<Record<string, string>>({})
  const [missing, setMissing] = createSignal(false)
  const driver = () => props.drivers.find((option) => option.id === driverId())
  const saving = () => props.store.activity()?.kind === "saving"
  const submit = async () => {
    const chosen = driver()
    if (!chosen) return
    const fields = Object.fromEntries(chosen.fields.map((field) => [field.key, (values[field.key] ?? "").trim()]))
    setMissing(Object.values(fields).some((value) => !value))
    if (missing()) return
    if (await props.store.save(chosen.id, fields)) dialog.close()
  }
  return (
    <FormDrawer
      title={t("settings.sandbox.add.title")}
      description={t("settings.sandbox.description")}
      submitLabel={t("settings.sandbox.add.save")}
      busyLabel={t("settings.sandbox.add.saving")}
      cancelLabel={t("common.cancel")}
      busy={saving()}
      error={missing() ? t("settings.sandbox.add.required") : undefined}
      onSubmit={() => void submit()}
      onCancel={() => dialog.close()}
    >
      <Field>
        <Field.Label>{t("settings.sandbox.add.provider")}</Field.Label>
        <Select
          aria-label={t("settings.sandbox.add.provider")}
          options={[...props.drivers]}
          current={driver()}
          value={(option) => option.id}
          label={(option) => option.label}
          onSelect={(option) => option && setDriverId(option.id)}
        />
      </Field>
      <For each={driver()?.fields ?? []}>
        {(field) => (
          <TextField
            type={field.secret ? "password" : "text"}
            autocomplete="off"
            label={field.label}
            name={field.key}
            value={values[field.key] ?? ""}
            onChange={(value) => setValues(field.key, value)}
          />
        )}
      </For>
    </FormDrawer>
  )
}
