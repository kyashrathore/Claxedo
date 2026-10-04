/// <reference types="bun" />
import { expect, test } from "bun:test"
import { validateCustomProvider, type FormState } from "./custom-provider"
import type { AccountsText } from "./i18n"
import en from "./locales/en"

const t: AccountsText = (key) => en[key]

function form(fields: Partial<FormState> = {}): FormState {
  return {
    providerId: "acme",
    name: "Acme",
    baseURL: "https://api.acme.test/v1",
    apiKey: "sk-acme",
    keyHeader: "Authorization",
    models: [{ row: "m1", id: "acme-1", name: "Acme One", err: {} }],
    headers: [{ row: "h1", key: "", value: "", err: {} }],
    err: {},
    ...fields,
  }
}

test("custom provider: the key rides in the named header, as a Bearer token only under Authorization", () => {
  expect(validateCustomProvider(form(), t, new Set()).result?.config.credentialHeader).toEqual({ name: "Authorization", scheme: "Bearer" })
  expect(validateCustomProvider(form({ keyHeader: " x-api-key " }), t, new Set()).result?.config.credentialHeader).toEqual({ name: "x-api-key" })
})

test("custom provider: a key header the broker cannot write, or a metadata header, is refused before anything is saved", () => {
  for (const keyHeader of ["", "Cookie", "Host", "HTTP-Referer", "Bad Header"]) {
    const output = validateCustomProvider(form({ keyHeader }), t, new Set())
    expect(output.result).toBeUndefined()
    expect(output.err.keyHeader).toBe(keyHeader ? en["provider.custom.error.keyHeader.invalid"] : en["provider.custom.error.required"])
  }
})

test("custom provider: extra headers are only the metadata allow-list, never a second credential", () => {
  const refused = validateCustomProvider(form({ headers: [{ row: "h1", key: "X-Api-Key", value: "secret", err: {} }] }), t, new Set())
  expect(refused.result).toBeUndefined()
  expect(refused.headers[0]?.key).toBe(en["provider.custom.error.header.metadata"])
  const allowed = validateCustomProvider(form({ headers: [{ row: "h1", key: "X-Title", value: "Claxedo", err: {} }] }), t, new Set())
  expect(allowed.result?.config.headers).toEqual({ "X-Title": "Claxedo" })
})
