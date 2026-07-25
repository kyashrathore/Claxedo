import { describe, expect, test } from "bun:test"
import { claudeSpawnEnv, createClaudeSdkDriver } from "./driver"
import { SDK_MODEL_CATALOG } from "../../sdk-model-catalog"

function driver() {
  return createClaudeSdkDriver({
    lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    bindSession() {},
  } as never)
}

describe("Claude SDK driver", () => {
  test("scrubs the local document installation secret from the child environment", () => {
    expect(claudeSpawnEnv({
      PATH: "/bin",
      CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "installation-secret",
    })).toEqual({ PATH: "/bin" })
  })

  /**
   * The live list comes from the SDK (`Query.supportedModels()`); `SDK_MODEL_CATALOG`
   * is the hand-maintained fallback served until a probe succeeds. These assertions
   * read the catalog rather than restating it: a copy here went stale against the
   * catalog (it still named `claude-sonnet-4-6`/`claude-opus-4-6`) and nothing caught
   * it, because a duplicated list only ever tests the duplicate.
   */
  test("serves the static Claude model catalog before any live probe", () => {
    const catalog = SDK_MODEL_CATALOG.claude

    expect(driver().peekConfigOptions(catalog[0].id)).toEqual([{
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: catalog[0].id,
      selectOptions: catalog.map((model) => ({ id: model.id, name: model.name })),
    }])
  })

  test("every fallback model is servable to the picker: unique id, non-empty name", () => {
    const catalog = SDK_MODEL_CATALOG.claude

    expect(catalog.length).toBeGreaterThan(0)
    expect(new Set(catalog.map((model) => model.id)).size).toBe(catalog.length)
    for (const model of catalog) {
      expect(model.id).toMatch(/^claude-/)
      expect(model.name.length).toBeGreaterThan(0)
    }
  })

  test("an unknown current model falls back to the first catalog entry", () => {
    const [option] = driver().peekConfigOptions("claude-from-a-future-release")

    expect(option?.currentValue).toBe(SDK_MODEL_CATALOG.claude[0].id)
  })
})
