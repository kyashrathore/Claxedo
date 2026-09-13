import { describe, expect, test } from "bun:test"
import { LOCALE_ENTRIES, type LocaleCode } from "./locales"
import { CONNECT_METHOD_COPY_BASES, CONNECT_METHOD_URLS } from "@/platform/identity/connect-methods"
import { CONNECT_CONTEXT_COPY } from "@/platform/identity/harness-catalog"

// The connect card once rendered `{{provider}}` from the model catalog, which
// has never heard of `claude-sdk` and fell back to printing the id. Every
// sentence there now composes from the harness/engine context instead, and
// these are the two things that would put an id back on screen.

const REGISTRY_IDS = /claude-sdk|codex-app-server|cursor-sdk|claude-acp|cursor-acp/

async function loadDict(code: LocaleCode): Promise<Record<string, string>> {
  // English lives in the base dictionary; every other locale's provider copy is
  // split out of it so the base files stay inside their size budget.
  const file = code === "br" ? "pt-BR" : code
  const base = (await import(`./${file}`)) as { dict: Record<string, string> }
  if (code === "en") return base.dict
  const provider = (await import(`./provider-settings/${file}`)) as { dict: Record<string, string> }
  return { ...base.dict, ...provider.dict }
}

describe("connect-card copy", () => {
  for (const entry of LOCALE_ENTRIES) {
    test(`${entry.code} never renders a registry provider id on the connect card`, async () => {
      const dict = await loadDict(entry.code)
      const offenders = Object.entries(dict)
        .filter(([key]) => key.startsWith("provider.connect."))
        .filter(([, value]) => value.includes("{{provider}}") || REGISTRY_IDS.test(value))
        .map(([key]) => key)

      expect(offenders).toEqual([])
    })

    test(`${entry.code} carries both the harness and the engine wording for every split key`, async () => {
      const dict = await loadDict(entry.code)
      const missing = Object.values(CONNECT_CONTEXT_COPY).flatMap((base) =>
        [`${base}.harness`, `${base}.engine`].filter((key) => !dict[key]))

      expect(missing).toEqual([])
    })

    test(`${entry.code} explains every method the catalog offers: what it is, who it is for, how to get it`, async () => {
      const dict = await loadDict(entry.code)
      const missing = CONNECT_METHOD_COPY_BASES.flatMap((base) =>
        ["title", "for", "how"].map((part) => `${base}.${part}`).filter((key) => !dict[key]?.trim()))

      expect(missing).toEqual([])
    })
  }

  test("every key page the card links to is an https URL the external-link helper can open", () => {
    const offenders = CONNECT_METHOD_URLS.filter((url) => !URL.canParse(url) || !url.startsWith("https://"))

    expect(offenders).toEqual([])
  })
})
