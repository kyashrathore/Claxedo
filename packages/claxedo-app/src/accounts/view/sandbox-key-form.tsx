import { createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { SandboxDriverOption } from "@/server"
import { SettingsNote } from "@/settings"
import { Button, Select, TextField } from "@/ui"
import { useAccountsText } from "../i18n"
import type { SandboxKeysStore } from "../sandbox-store"

export function SandboxKeyForm(props: { readonly drivers: readonly SandboxDriverOption[]; readonly store: SandboxKeysStore; readonly onDone: () => void }) {
  const t = useAccountsText()
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
    if (await props.store.save(chosen.id, fields)) props.onDone()
  }
  return (
    <form class="settings-fields" aria-label={t("settings.sandbox.add")} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <Select
        aria-label={t("settings.sandbox.add.provider")}
        options={[...props.drivers]}
        current={driver()}
        value={(option) => option.id}
        label={(option) => option.label}
        onSelect={(option) => option && setDriverId(option.id)}
        appearance="inline"
      />
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
      <Show when={missing()}>
        <SettingsNote tone="danger">{t("settings.sandbox.add.required")}</SettingsNote>
      </Show>
      <div class="flex items-center gap-2">
        <Button type="submit" size="small" disabled={saving()}>{saving() ? t("settings.sandbox.add.saving") : t("settings.sandbox.add.save")}</Button>
        <Button type="button" size="small" variant="ghost" disabled={saving()} onClick={() => props.onDone()}>{t("common.cancel")}</Button>
      </div>
    </form>
  )
}
