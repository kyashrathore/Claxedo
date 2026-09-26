import { batch, createSignal, For } from "solid-js"
import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { toAppError, useServer } from "@/server"
import { ClaxedoIconButton as IconButton, showToast, useDialog, Button, Dialog, Icon, ProviderIcon, TextField, DialogBody, DialogHeader, DialogTitle } from "@/ui"
import { headerRow, modelRow, validateCustomProvider, type FormState } from "../custom-provider"
import { useAccountsText, type AccountsKey } from "../i18n"

const DOCS_URL = "https://opencode.ai/docs/providers/#custom-provider"

type RowList = "models" | "headers"

type RowCopy = { readonly first: AccountsKey; readonly second: AccountsKey; readonly firstHint: AccountsKey; readonly secondHint: AccountsKey; readonly remove: AccountsKey; readonly add: AccountsKey; readonly label: AccountsKey }

const ROW_COPY: Record<RowList, RowCopy> = {
  models: { first: "provider.custom.models.id.label", second: "provider.custom.models.name.label", firstHint: "provider.custom.models.id.placeholder", secondHint: "provider.custom.models.name.placeholder", remove: "provider.custom.models.remove", add: "provider.custom.models.add", label: "provider.custom.models.label" },
  headers: { first: "provider.custom.headers.key.label", second: "provider.custom.headers.value.label", firstHint: "provider.custom.headers.key.placeholder", secondHint: "provider.custom.headers.value.placeholder", remove: "provider.custom.headers.remove", add: "provider.custom.headers.add", label: "provider.custom.headers.label" },
}

function PairRows(props: { readonly list: RowList; readonly form: FormState; readonly setForm: SetStoreFunction<FormState> }) {
  const t = useAccountsText()
  const copy = () => ROW_COPY[props.list]
  const rows = () => props.form[props.list].map((entry) => ("id" in entry ? { row: entry.row, a: entry.id, b: entry.name, errA: entry.err.id, errB: entry.err.name } : { row: entry.row, a: entry.key, b: entry.value, errA: entry.err.key, errB: entry.err.value }))
  const fields = (): [string, string] => (props.list === "models" ? ["id", "name"] : ["key", "value"])
  const set = (index: number, which: 0 | 1, value: string) => {
    const field = fields()[which]
    batch(() => {
      props.setForm(props.list, index, produce((entry: Record<string, unknown>) => {
        entry[field] = value
        entry.err = { ...(entry.err as object), [field]: undefined }
      }))
    })
  }
  const add = () => (props.list === "models" ? props.setForm("models", (list) => [...list, modelRow()]) : props.setForm("headers", (list) => [...list, headerRow()]))
  const remove = (index: number) => {
    if (props.form[props.list].length <= 1) return
    const keep = <T,>(list: readonly T[]) => list.filter((_, at) => at !== index)
    if (props.list === "models") props.setForm("models", keep)
    else props.setForm("headers", keep)
  }
  return (
    <div class="flex flex-col gap-3">
      <label class="text-12-medium text-text-weak">{t(copy().label)}</label>
      <For each={rows()}>
        {(entry, index) => (
          <div class="flex gap-2 items-start" data-row={entry.row}>
            <div class="flex-1">
              <TextField label={t(copy().first)} hideLabel placeholder={t(copy().firstHint)} value={entry.a} onChange={(value) => set(index(), 0, value)} invalid={!!entry.errA} error={entry.errA} />
            </div>
            <div class="flex-1">
              <TextField label={t(copy().second)} hideLabel placeholder={t(copy().secondHint)} value={entry.b} onChange={(value) => set(index(), 1, value)} invalid={!!entry.errB} error={entry.errB} />
            </div>
            <IconButton type="button" icon="trash" variant="ghost" class="mt-1.5" onClick={() => remove(index())} disabled={rows().length <= 1} aria-label={t(copy().remove)} />
          </div>
        )}
      </For>
      <Button type="button" size="small" variant="ghost" onClick={add} class="self-start">
        <Icon name="plus-small" size="small" />
        {t(copy().add)}
      </Button>
    </div>
  )
}

function ProviderFields(props: { readonly form: FormState; readonly setForm: SetStoreFunction<FormState> }) {
  const t = useAccountsText()
  const set = (key: "providerId" | "name" | "baseURL" | "apiKey", value: string) => {
    props.setForm(key, value)
    if (key !== "apiKey") props.setForm("err", key, undefined)
  }
  return (
    <div class="flex flex-col gap-4">
      <TextField autofocus label={t("provider.custom.field.providerID.label")} placeholder={t("provider.custom.field.providerID.placeholder")} description={t("provider.custom.field.providerID.description")} value={props.form.providerId} onChange={(value) => set("providerId", value)} invalid={!!props.form.err.providerId} error={props.form.err.providerId} />
      <TextField label={t("provider.custom.field.name.label")} placeholder={t("provider.custom.field.name.placeholder")} value={props.form.name} onChange={(value) => set("name", value)} invalid={!!props.form.err.name} error={props.form.err.name} />
      <TextField label={t("provider.custom.field.baseURL.label")} placeholder={t("provider.custom.field.baseURL.placeholder")} value={props.form.baseURL} onChange={(value) => set("baseURL", value)} invalid={!!props.form.err.baseURL} error={props.form.err.baseURL} />
      <TextField label={t("provider.custom.field.apiKey.label")} placeholder={t("provider.custom.field.apiKey.placeholder")} description={t("provider.custom.field.apiKey.description")} value={props.form.apiKey} onChange={(value) => set("apiKey", value)} />
    </div>
  )
}

function useSave(props: { readonly existing: ReadonlySet<string>; readonly onSaved: () => Promise<void> }, form: FormState, setForm: SetStoreFunction<FormState>) {
  const t = useAccountsText()
  const server = useServer()
  const dialog = useDialog()
  const [saving, setSaving] = createSignal(false)
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (saving()) return
    const output = validateCustomProvider(form, t, props.existing)
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    if (!output.result) return
    setSaving(true)
    try {
      await server.providerConnect.saveCustomProvider(output.result)
      await props.onSaved()
      dialog.close()
      showToast({ variant: "success", icon: <Icon name="circle-check" />, title: t("provider.connect.toast.connected.title", { vendor: output.result.config.name }) })
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
    } finally {
      setSaving(false)
    }
  }
  return { saving, save }
}

export function DialogCustomProvider(props: { readonly existing: ReadonlySet<string>; readonly onSaved: () => Promise<void> }) {
  const t = useAccountsText()
  const dialog = useDialog()
  const [form, setForm] = createStore<FormState>({ providerId: "", name: "", baseURL: "", apiKey: "", models: [modelRow()], headers: [headerRow()], err: {} })
  const { saving, save } = useSave(props, form, setForm)
  return (
    <Dialog size="large" fit>
      <DialogHeader>
        <DialogTitle>
          <IconButton tabIndex={-1} icon="arrow-left" variant="ghost" onClick={() => dialog.close()} aria-label={t("common.goBack")} />
        </DialogTitle>
      </DialogHeader>
      <DialogBody class="flex flex-col gap-6 overflow-y-auto max-h-[60vh] px-4 pb-4">
        <div class="flex gap-4 items-center">
          <ProviderIcon id="synthetic" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">{t("provider.custom.title")}</div>
        </div>
        <form onSubmit={(event) => void save(event)} class="flex flex-col gap-6">
          <p class="text-14-regular text-text-base">
            {t("provider.custom.description.prefix")}
            <a href={DOCS_URL} target="_blank" rel="noreferrer" tabIndex={-1} class="text-text-strong underline">
              {t("provider.custom.description.link")}
            </a>
            {t("provider.custom.description.suffix")}
          </p>
          <ProviderFields form={form} setForm={setForm} />
          <PairRows list="models" form={form} setForm={setForm} />
          <PairRows list="headers" form={form} setForm={setForm} />
          <Button class="w-auto self-start" type="submit" size="large" variant="contrast" disabled={saving()}>
            {saving() ? t("common.saving") : t("common.submit")}
          </Button>
        </form>
      </DialogBody>
    </Dialog>
  )
}
