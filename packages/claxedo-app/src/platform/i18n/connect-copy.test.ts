import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { LOCALE_ENTRIES, type LocaleCode } from "./locales"

// The connect card once rendered `{{provider}}` from the model catalog, which
// has never heard of `claude-sdk` and fell back to printing the id. Every
// sentence there now composes from the harness/engine context instead, and
// these are the two things that would put an id back on screen.

const REGISTRY_IDS = /claude-sdk|codex-app-server|cursor-sdk|claude-acp|cursor-acp/

/** Both halves are read by the same call site, so one without the other is a missing string. */
const SPLIT_KEYS = [
  "provider.connect.title",
  "provider.connect.apiKey.description",
  "provider.connect.oauth.description",
  "provider.connect.oauth.code.visit.suffix",
  "provider.connect.oauth.auto.visit.suffix",
  "provider.connect.toast.connected.description",
]

async function loadDict(code: LocaleCode): Promise<Record<string, string>> {
  const module = (await import(`./${code === "br" ? "pt-BR" : code}`)) as { dict: Record<string, string> }
  return module.dict
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
      const missing = SPLIT_KEYS.flatMap((base) =>
        [`${base}.harness`, `${base}.engine`].filter((key) => !dict[key]))

      expect(missing).toEqual([])
    })
  }

  test("the English card no longer claims the account is being connected for OpenCode", () => {
    const claims = Object.entries(en)
      .filter(([key]) => key.startsWith("provider.connect."))
      .filter(([, value]) => value.includes("in OpenCode"))
      .map(([key]) => key)

    expect(claims).toEqual([])
  })
})
