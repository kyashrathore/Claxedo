import { describe, expect, test } from "bun:test"
import { providerSafeInputSchema } from "@/tool/application-tool-runtime"

/**
 * Anthropic rejects an entire request when any tool's `input_schema` lacks a
 * top-level `type` — `tools.37.custom.input_schema.type: Field required`, with
 * no clue which tool. Observed live: `workgraph_ledger`'s discriminated union
 * serialised to a bare `oneOf`, and every turn in the session failed.
 */
describe("provider-safe tool input schemas", () => {
  const unionOfObjects = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    oneOf: [
      { type: "object", properties: { action: { const: "create_task" } } },
      { type: "object", properties: { action: { const: "mark_done" } } },
    ],
  }

  test("flattens a union of object variants into one object schema", () => {
    // The real shape `z.toJSONSchema(z.discriminatedUnion(...))` produces.
    // Anthropic rejects BOTH a missing top-level type and any oneOf/anyOf/allOf.
    const out = providerSafeInputSchema("workgraph_ledger", unionOfObjects)
    expect(out.type).toBe("object")
    expect(out.oneOf).toBeUndefined()
    expect(out.anyOf).toBeUndefined()
    expect(out.allOf).toBeUndefined()
  })

  test("keeps every variant's properties so the model still sees all fields", () => {
    const out = providerSafeInputSchema("workgraph_ledger", {
      oneOf: [
        { type: "object", properties: { action: {}, title: {} }, required: ["action", "title"] },
        { type: "object", properties: { action: {}, summary: {} }, required: ["action", "summary"] },
      ],
    })
    expect(Object.keys(out.properties as object).sort()).toEqual(["action", "summary", "title"])
  })

  test("requires only what EVERY variant requires — per-variant fields are optional", () => {
    // Requiring a branch-specific field would make the other branch unusable.
    const out = providerSafeInputSchema("workgraph_ledger", {
      oneOf: [
        { type: "object", properties: { action: {}, title: {} }, required: ["action", "title"] },
        { type: "object", properties: { action: {}, summary: {} }, required: ["action", "summary"] },
      ],
    })
    expect(out.required).toEqual(["action"])
  })

  test("does not mutate the caller's schema", () => {
    const original = structuredClone(unionOfObjects)
    providerSafeInputSchema("workgraph_ledger", unionOfObjects)
    expect(unionOfObjects).toEqual(original)
  })

  test("passes through a schema that already declares its type", () => {
    const fine = { type: "object", properties: { path: { type: "string" } } }
    expect(providerSafeInputSchema("read", fine)).toBe(fine)
  })

  test("handles anyOf and allOf the same way", () => {
    for (const key of ["anyOf", "allOf"] as const) {
      const out = providerSafeInputSchema("t", { [key]: [{ type: "object" }, { type: "object" }] })
      expect(out.type).toBe("object")
      expect(out[key]).toBeUndefined()
    }
  })

  test("does NOT guess when the variants are not all objects", () => {
    // `type` is only recoverable because a union of objects IS an object.
    // A union including a string has no single correct top-level type, and
    // inventing one would send a wrong schema rather than a missing one.
    const mixed = { oneOf: [{ type: "object" }, { type: "string" }] }
    expect(providerSafeInputSchema("t", mixed)).toBe(mixed)
  })

  test("leaves an unrecognisable schema alone rather than fabricating structure", () => {
    expect(providerSafeInputSchema("t", {}).type).toBeUndefined()
    expect(providerSafeInputSchema("t", { oneOf: "not-an-array" as never }).type).toBeUndefined()
  })
})
