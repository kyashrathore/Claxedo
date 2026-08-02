import { describe, expect, it } from "vitest"
import { isCanonicalWorkGraphArchiveRestoreError } from "../src/conformance/archive"

describe("archive conformance public error identity", () => {
  it("accepts the exact public error shape from a separately bundled class identity", () => {
    class SeparatelyBundledArchiveError extends Error {
      override readonly name = "WorkGraphArchiveRestoreError"
      readonly code = "archive_restore_rejected"

      constructor(readonly reason: "cross_owner") {
        super("WorkGraph archive restore was rejected")
      }
    }

    expect(isCanonicalWorkGraphArchiveRestoreError(new SeparatelyBundledArchiveError("cross_owner"), "cross_owner")).toBe(true)
  })

  it("rejects errors with the wrong stable name, code, reason, or Error prototype", () => {
    expect(isCanonicalWorkGraphArchiveRestoreError(new Error("rejected"), "cross_owner")).toBe(false)
    expect(isCanonicalWorkGraphArchiveRestoreError(
      Object.assign(new Error("rejected"), { name: "WorkGraphArchiveRestoreError", code: "other", reason: "cross_owner" }),
      "cross_owner",
    )).toBe(false)
    expect(isCanonicalWorkGraphArchiveRestoreError(
      { name: "WorkGraphArchiveRestoreError", code: "archive_restore_rejected", reason: "cross_owner", message: "rejected" },
      "cross_owner",
    )).toBe(false)
  })
})
