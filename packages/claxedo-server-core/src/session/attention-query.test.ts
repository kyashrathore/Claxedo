import { describe, expect, test } from "vitest"
import { parseSessionAttentionPageQuery } from "./attention-query"

describe("session attention query", () => {
  test("applies the omitted cursor and bounded page defaults", () => {
    expect(parseSessionAttentionPageQuery({})).toEqual({ after: 0, limit: 256 })
    expect(parseSessionAttentionPageQuery({ after: "0", limit: "1" })).toEqual({ after: 0, limit: 1 })
    expect(parseSessionAttentionPageQuery({ after: String(Number.MAX_SAFE_INTEGER), limit: "256" }))
      .toEqual({ after: Number.MAX_SAFE_INTEGER, limit: 256 })
    expect(parseSessionAttentionPageQuery({ after: "001" })).toEqual({ after: 1, limit: 256 })
  })

  test("rejects coercible but nondecimal inputs and unsafe or unbounded pages", () => {
    for (const after of ["", " ", " 1", "1 ", "+1", "-1", "1.0", "1e2", "0x10", "Infinity", "NaN", "9007199254740992"]) {
      expect(parseSessionAttentionPageQuery({ after })).toBeUndefined()
    }
    for (const limit of ["0", "257", "1.5", "-1", " 1", "1e2", "9007199254740992"]) {
      expect(parseSessionAttentionPageQuery({ limit })).toBeUndefined()
    }
  })
})
