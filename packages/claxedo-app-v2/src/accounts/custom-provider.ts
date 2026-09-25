import type { CustomProviderDraft } from "@/server"
import type { AccountsText } from "./i18n"

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/

type ModelErr = { id?: string; name?: string }

type HeaderErr = { key?: string; value?: string }

export type ModelRow = { row: string; id: string; name: string; err: ModelErr }

export type HeaderRow = { row: string; key: string; value: string; err: HeaderErr }

export type FormState = {
  providerId: string
  name: string
  baseURL: string
  apiKey: string
  models: ModelRow[]
  headers: HeaderRow[]
  err: { providerId?: string; name?: string; baseURL?: string }
}

function fieldErrors(form: FormState, t: AccountsText, existing: ReadonlySet<string>) {
  const providerId = form.providerId.trim()
  const baseURL = form.baseURL.trim()
  const idError = !providerId ? t("provider.custom.error.providerID.required") : !PROVIDER_ID.test(providerId) ? t("provider.custom.error.providerID.format") : undefined
  const existsError = idError || !existing.has(providerId) ? undefined : t("provider.custom.error.providerID.exists")
  const urlError = !baseURL ? t("provider.custom.error.baseURL.required") : !/^https?:\/\//.test(baseURL) ? t("provider.custom.error.baseURL.format") : undefined
  const nameError = form.name.trim() ? undefined : t("provider.custom.error.name.required")
  return { providerId: idError ?? existsError, name: nameError, baseURL: urlError }
}

function modelErrors(rows: readonly ModelRow[], t: AccountsText): ModelErr[] {
  const seen = new Set<string>()
  return rows.map((model) => {
    const id = model.id.trim()
    const idError = !id ? t("provider.custom.error.required") : seen.has(id) ? t("provider.custom.error.duplicate") : undefined
    seen.add(id)
    return { id: idError, name: model.name.trim() ? undefined : t("provider.custom.error.required") }
  })
}

function headerErrors(rows: readonly HeaderRow[], t: AccountsText): HeaderErr[] {
  const seen = new Set<string>()
  return rows.map((header) => {
    const key = header.key.trim()
    const value = header.value.trim()
    if (!key && !value) return {}
    const keyError = !key ? t("provider.custom.error.required") : seen.has(key.toLowerCase()) ? t("provider.custom.error.duplicate") : undefined
    seen.add(key.toLowerCase())
    return { key: keyError, value: value ? undefined : t("provider.custom.error.required") }
  })
}

function draftOf(form: FormState): CustomProviderDraft {
  const apiKey = form.apiKey.trim()
  const env = apiKey.match(/^\{env:([^}]+)\}$/)?.[1]?.trim()
  const key = apiKey && !env ? apiKey : undefined
  const headers = form.headers.map((header) => ({ key: header.key.trim(), value: header.value.trim() })).filter((header) => header.key && header.value)
  return {
    ...(key === undefined ? {} : { key }),
    config: {
      providerId: form.providerId.trim(),
      name: form.name.trim(),
      baseURL: form.baseURL.trim(),
      env: env ? [env] : [],
      headers: Object.fromEntries(headers.map((header) => [header.key, header.value])),
      models: Object.fromEntries(form.models.map((model) => [model.id.trim(), { name: model.name.trim() }])),
    },
  }
}

export function validateCustomProvider(form: FormState, t: AccountsText, existing: ReadonlySet<string>) {
  const err = fieldErrors(form, t, existing)
  const models = modelErrors(form.models, t)
  const headers = headerErrors(form.headers, t)
  const clean = (errors: readonly object[]) => errors.every((entry) => Object.values(entry).every((value) => value === undefined))
  const ok = clean([err]) && clean(models) && clean(headers)
  return { err, models, headers, ...(ok ? { result: draftOf(form) } : {}) }
}

let row = 0

const nextRow = () => `row-${row++}`

export const modelRow = (): ModelRow => ({ row: nextRow(), id: "", name: "", err: {} })

export const headerRow = (): HeaderRow => ({ row: nextRow(), key: "", value: "", err: {} })
