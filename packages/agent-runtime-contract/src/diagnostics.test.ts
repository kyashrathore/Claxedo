import { describe, expect, test } from "bun:test"
import { normalizeDiagnostics, runtimeDiagnostic } from "./index"

describe("runtime diagnostics", () => {
  test("reads structural fields and retains opaque diagnostic payloads", () => {
    const raw = { native: [1, "message"] }
    expect(normalizeDiagnostics([{
      code: "provider.failed", message: "Failed", severity: "error",
      source: "provider", method: "turn", raw, details: { retryable: false },
    }])).toEqual([{
      code: "provider.failed", message: "Failed", severity: "error",
      source: "provider", method: "turn", raw, details: { retryable: false },
    }])
    expect(runtimeDiagnostic({ code: "empty", message: "", raw: null }).raw).toBeNull()
  })

  test("rejects invalid rows and ignores malformed optional fields", () => {
    expect(normalizeDiagnostics({ code: "invalid" })).toEqual([])
    expect(normalizeDiagnostics([null, [], "invalid", { code: 1, message: "bad" }, {
      code: "valid", message: "", severity: "invalid", source: "", method: 42, details: [],
    }])).toEqual([{ code: "valid", message: "", severity: "warn" }])
  })
})
