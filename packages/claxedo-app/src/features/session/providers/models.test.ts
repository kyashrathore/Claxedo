import { describe, expect, test } from "bun:test"
import { decodeModelStoreRecord, resolveModelVisibility } from "./models"

describe("decodeModelStoreRecord", () => {
  test("does not import a legacy unscoped provider preference record", () => {
    expect(decodeModelStoreRecord({
      user: [{ providerID: "anthropic", modelID: "opus", visibility: "hide" }],
      recent: [{ providerID: "anthropic", modelID: "opus" }],
      variant: { "anthropic/opus": "thinking" },
    })).toEqual({
      user: {},
      recent: [],
      variant: {},
    })
  })

  test("reads the harness-keyed shape back unchanged", () => {
    const record = {
      user: { "claude-sdk": [{ providerID: "anthropic", modelID: "opus", visibility: "show" as const }] },
      recent: [{ providerID: "anthropic", modelID: "opus", harness: "claude-sdk" }],
      variant: { "claude-sdk": { "anthropic/opus": "max" } },
    }
    expect(decodeModelStoreRecord(record)).toEqual(record)
    expect(decodeModelStoreRecord(decodeModelStoreRecord(record))).toEqual(record)
  })

  test("a recent entry with no harness names no harness, so it is dropped", () => {
    expect(decodeModelStoreRecord({
      user: {},
      recent: [{ providerID: "anthropic", modelID: "opus" }],
      variant: {},
    }).recent).toEqual([])
  })

  test("malformed payloads decode to an empty record rather than throwing", () => {
    expect(decodeModelStoreRecord(undefined)).toEqual({ user: {}, recent: [], variant: {} })
    expect(decodeModelStoreRecord([1, 2])).toEqual({ user: {}, recent: [], variant: {} })
    expect(decodeModelStoreRecord({ user: [{ providerID: 1 }] })).toEqual({
      user: {},
      recent: [],
      variant: {},
    })
  })
})

describe("resolveModelVisibility", () => {
  test("an explicit user choice wins over the provider default", () => {
    const model = { providerID: "anthropic", modelID: "opus" }
    const defaults = { anthropic: "opus" }
    expect(resolveModelVisibility({ model, defaults, user: "hide" })).toBe(false)
    expect(resolveModelVisibility({ model, defaults: {}, user: "show" })).toBe(true)
    expect(resolveModelVisibility({ model, defaults })).toBe(true)
    expect(resolveModelVisibility({ model, defaults: {} })).toBe(false)
  })
})
