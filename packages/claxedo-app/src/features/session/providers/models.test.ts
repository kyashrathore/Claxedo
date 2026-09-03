import { describe, expect, test } from "bun:test"
import { decodeModelStoreRecord, resolveModelVisibility } from "./models"

describe("decodeModelStoreRecord", () => {
  test("re-homes the replaced global store under the harness it belonged to", () => {
    expect(decodeModelStoreRecord({
      user: [{ providerID: "anthropic", modelID: "opus", visibility: "hide" }],
      recent: [{ providerID: "anthropic", modelID: "opus" }],
      variant: { "anthropic/opus": "thinking" },
    }, "opencode")).toEqual({
      user: { opencode: [{ providerID: "anthropic", modelID: "opus", visibility: "hide" }] },
      recent: [{ providerID: "anthropic", modelID: "opus", harness: "opencode" }],
      variant: { opencode: { "anthropic/opus": "thinking" } },
    })
  })

  test("reads the harness-keyed shape back unchanged, so the upgrade runs once", () => {
    const record = {
      user: { "claude-sdk": [{ providerID: "anthropic", modelID: "opus", visibility: "show" as const }] },
      recent: [{ providerID: "anthropic", modelID: "opus", harness: "claude-sdk" }],
      variant: { "claude-sdk": { "anthropic/opus": "max" } },
    }
    expect(decodeModelStoreRecord(record, "opencode")).toEqual(record)
    expect(decodeModelStoreRecord(decodeModelStoreRecord(record, "opencode"), "opencode")).toEqual(record)
  })

  test("a recent entry with no harness names no harness, so it is dropped", () => {
    expect(decodeModelStoreRecord({
      user: {},
      recent: [{ providerID: "anthropic", modelID: "opus" }],
      variant: {},
    }, "opencode").recent).toEqual([])
  })

  test("malformed payloads decode to an empty record rather than throwing", () => {
    expect(decodeModelStoreRecord(undefined, "opencode")).toEqual({ user: {}, recent: [], variant: {} })
    expect(decodeModelStoreRecord([1, 2], "opencode")).toEqual({ user: {}, recent: [], variant: {} })
    expect(decodeModelStoreRecord({ user: [{ providerID: 1 }] }, "opencode")).toEqual({
      user: { opencode: [] },
      recent: [],
      variant: { opencode: {} },
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
