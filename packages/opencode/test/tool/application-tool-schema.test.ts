import { describe, expect, test } from "bun:test"
import { requireProviderInputSchema } from "@/tool/application-tool-runtime"

describe("provider-safe tool input schemas", () => {
  test("accepts the producer's explicit object schema", () => {
    const fine = { type: "object", properties: { path: { type: "string" } } }
    expect(requireProviderInputSchema("read", fine)).toBe(fine)
  })

  test("rejects schemas without an object root", () => {
    expect(() => requireProviderInputSchema("ledger", {})).toThrow(
      'Application tool "ledger" inputSchema must declare top-level type "object"',
    )
  })

  test("rejects every unsupported top-level union keyword", () => {
    for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
      expect(() => requireProviderInputSchema("ledger", { type: "object", [keyword]: [] })).toThrow(
        `Application tool "ledger" inputSchema cannot declare top-level ${keyword}`,
      )
    }
  })
})
