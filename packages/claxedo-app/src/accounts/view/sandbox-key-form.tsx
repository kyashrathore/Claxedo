import { createSignal, For, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { SandboxDriverOption } from "@/server"
import { Button, Field, FormDrawer, Select, TextField, useDialog } from "@/ui"
import { useAccountsText } from "../i18n"
import type { SandboxKeysStore } from "../sandbox-store"

export type SandboxKeyDraft = ReturnType<typeof createSandboxKeyDraft>

export function createSandboxKeyDraft(drivers: Accessor<readonly SandboxDriverOption[]>, store: SandboxKeysStore) {
  const [driverId, setDriverId] = createSignal(drivers()[0]?.id)
  const [values, setValues] = createStore<Record<string, string>>({})
  const [missing, setMissing] = createSignal(false)
  const driver = () => drivers().find((option) => option.id === driverId())
  return {
    driver,
    chooseDriver: setDriverId,
    value: (key: string) => values[key] ?? "",
    setValue: (key: string, value: string) => setValues(key, value),
    missing,
    saving: () => store.activity()?.kind === "saving",
    submit: async () => {
      const chosen = driver()
      if (!chosen) return false
      const fields = Object.fromEntries(chosen.fields.map((field) => [field.key, (values[field.key] ?? "").trim()]))
      const incomplete = Object.values(fields).some((value) => !value)
      setMissing(incomplete)
      if (incomplete) return false
      return await store.save(chosen.id, fields)
    },
  }
}

export function SandboxKeyFields(props: { readonly drivers: readonly SandboxDriverOption[]; readonly draft: SandboxKeyDraft }) {
  const t = useAccountsText()
  return (
    <>
      <Field>
        <Field.Label>{t("settings.sandbox.add.provider")}</Field.Label>
        <Select
          aria-label={t("settings.sandbox.add.provider")}
          options={[...props.drivers]}
          current={props.draft.driver()}
          value={(option) => option.id}
          label={(option) => option.label}
          onSelect={(option) => option && props.draft.chooseDriver(option.id)}
        />
      </Field>
      <For each={props.draft.driver()?.fields ?? []}>
        {(field) => (
          <TextField
            type={field.secret ? "password" : "text"}
            autocomplete="off"
            label={field.label}
            name={field.key}
            value={props.draft.value(field.key)}
            onChange={(value) => props.draft.setValue(field.key, value)}
          />
        )}
      </For>
    </>
  )
}

export function DrawerSandboxKey(props: { readonly drivers: readonly SandboxDriverOption[]; readonly store: SandboxKeysStore }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const draft = createSandboxKeyDraft(() => props.drivers, props.store)
  return (
    <FormDrawer
      title={t("settings.sandbox.add.title")}
      description={t("settings.sandbox.description")}
      submitLabel={t("settings.sandbox.add.save")}
      busyLabel={t("settings.sandbox.add.saving")}
      cancelLabel={t("common.cancel")}
      busy={draft.saving()}
      error={draft.missing() ? t("settings.sandbox.add.required") : undefined}
      onSubmit={() => void draft.submit().then((saved) => saved && dialog.close())}
      onCancel={() => dialog.close()}
    >
      <SandboxKeyFields drivers={props.drivers} draft={draft} />
    </FormDrawer>
  )
}

export function InlineSandboxKeyForm(props: {
  readonly drivers: readonly SandboxDriverOption[]
  readonly store: SandboxKeysStore
  readonly onSaved: () => void
  readonly onCancel?: () => void
}) {
  const t = useAccountsText()
  const draft = createSandboxKeyDraft(() => props.drivers, props.store)
  return (
    <form
      class="flex flex-col gap-3"
      aria-label={t("settings.sandbox.add.title")}
      onSubmit={(event) => {
        event.preventDefault()
        void draft.submit().then((saved) => saved && props.onSaved())
      }}
    >
      <SandboxKeyFields drivers={props.drivers} draft={draft} />
      <Show when={draft.missing()}>
        <p class="text-12-regular text-icon-critical-base" role="alert">{t("settings.sandbox.add.required")}</p>
      </Show>
      <div class="flex items-center gap-2">
        <Button type="submit" variant="contrast" size="small" disabled={draft.saving()}>
          {draft.saving() ? t("settings.sandbox.add.saving") : t("settings.sandbox.add.save")}
        </Button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <Button type="button" variant="ghost" size="small" disabled={draft.saving()} onClick={() => cancel()()}>
              {t("common.cancel")}
            </Button>
          )}
        </Show>
      </div>
    </form>
  )
}
