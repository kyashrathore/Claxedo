import { describe, expect, test } from "bun:test"
import { decodeModelStoreRecord, decodeModelVisibilityRecord, resolveModelVisibility } from "./models"

describe("decodeModelStoreRecord", () => {
  test("does not import a legacy unscoped provider preference record", () => {
    expect(decodeModelStoreRecord({
      user: [{ providerID: "anthropic", modelID: "opus", visibility: "hide" }],
      recent: [{ providerID: "anthropic", modelID: "opus" }],
      variant: { "anthropic/opus": "thinking" },
    })).toEqual({ recent: [], variant: {} })
  })

  test("reads the harness-keyed shape back unchanged and drops a per-workspace visibility list", () => {
    const record = {
      recent: [{ providerID: "anthropic", modelID: "opus", harness: "claude-sdk" }],
      variant: { "claude-sdk": { "anthropic/opus": "max" } },
    }
    expect(decodeModelStoreRecord(record)).toEqual(record)
    expect(decodeModelStoreRecord(decodeModelStoreRecord(record))).toEqual(record)
    expect(decodeModelStoreRecord({
      ...record,
      user: { "claude-sdk": [{ providerID: "anthropic", modelID: "opus", visibility: "hide" }] },
    })).toEqual(record)
  })

  test("a recent entry with no harness names no harness, so it is dropped", () => {
    expect(decodeModelStoreRecord({
      recent: [{ providerID: "anthropic", modelID: "opus" }],
      variant: {},
    }).recent).toEqual([])
  })

  test("malformed payloads decode to an empty record rather than throwing", () => {
    expect(decodeModelStoreRecord(undefined)).toEqual({ recent: [], variant: {} })
    expect(decodeModelStoreRecord([1, 2])).toEqual({ recent: [], variant: {} })
    expect(decodeModelStoreRecord({ user: [{ providerID: 1 }] })).toEqual({ recent: [], variant: {} })
  })
})

describe("decodeModelVisibilityRecord", () => {
  test("keeps show/hide answers and drops anything else, per model and per group", () => {
    expect(decodeModelVisibilityRecord({
      entries: { "anthropic:opus": "hide", "claude:sonnet": "show", "openai:gpt": "maybe", "pi:x": 1 },
      groups: { anthropic: "show", "pi/amazon-bedrock": "hide", openai: "maybe" },
    })).toEqual({
      entries: { "anthropic:opus": "hide", "claude:sonnet": "show" },
      groups: { anthropic: "show", "pi/amazon-bedrock": "hide" },
    })
    expect(decodeModelVisibilityRecord(undefined)).toEqual({ entries: {}, groups: {} })
    expect(decodeModelVisibilityRecord({ entries: [] })).toEqual({ entries: {}, groups: {} })
  })

  test("a record written before group answers existed decodes with none", () => {
    expect(decodeModelVisibilityRecord({ entries: { "anthropic:opus": "hide" } }))
      .toEqual({ entries: { "anthropic:opus": "hide" }, groups: {} })
  })
})

describe("resolveModelVisibility", () => {
  test("a group answer covers its models, and a per-model answer overrides it", () => {
    const model = { providerID: "pi", modelID: "amazon-bedrock/nova-lite" }
    expect(resolveModelVisibility({ model, defaults: {}, group: "hide" })).toBe(false)
    expect(resolveModelVisibility({ model, defaults: {}, group: "hide", user: "show" })).toBe(true)
    expect(resolveModelVisibility({ model, defaults: {}, group: "show", connected: false })).toBe(true)
  })

  test("a model the harness holds no credential for is off until it is asked for", () => {
    const model = { providerID: "pi", modelID: "amazon-bedrock/nova-lite" }
    expect(resolveModelVisibility({ model, defaults: {}, connected: false })).toBe(false)
    expect(resolveModelVisibility({ model, defaults: {}, connected: true })).toBe(true)
    // A harness that reports no such fact keeps the list it reported as the offer.
    expect(resolveModelVisibility({ model, defaults: {} })).toBe(true)
  })

  test("an explicit user choice wins over the provider default", () => {
    const model = { providerID: "anthropic", modelID: "opus" }
    const defaults = { anthropic: "opus" }
    expect(resolveModelVisibility({ model, defaults, user: "hide" })).toBe(false)
    expect(resolveModelVisibility({ model, defaults: {}, user: "show" })).toBe(true)
    expect(resolveModelVisibility({ model, defaults })).toBe(true)
    expect(resolveModelVisibility({ model, defaults: { anthropic: "sonnet" } })).toBe(false)
  })

  test("a provider without a catalog default offers every model until one is hidden", () => {
    const model = { providerID: "claude", modelID: "opus" }
    expect(resolveModelVisibility({ model, defaults: {} })).toBe(true)
    expect(resolveModelVisibility({ model, defaults: { anthropic: "sonnet" } })).toBe(true)
    expect(resolveModelVisibility({ model, defaults: {}, user: "hide" })).toBe(false)
  })
})
