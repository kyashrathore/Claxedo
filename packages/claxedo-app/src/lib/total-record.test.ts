import { describe, expect, test } from "bun:test"
import { totalRecord } from "./total-record"

describe("totalRecord", () => {
  test("keys the result by the manifest's own key function", () => {
    const entries = [
      { code: "en", label: "English" },
      { code: "de", label: "Deutsch" },
    ] as const
    expect(totalRecord(entries, (entry) => entry.code, (entry) => entry.label)).toEqual({
      en: "English",
      de: "Deutsch",
    })
  })

  test("a later row wins the key it repeats", () => {
    const entries = [
      { code: "en", label: "first" },
      { code: "en", label: "second" },
    ] as const
    expect(totalRecord(entries, (entry) => entry.code, (entry) => entry.label)).toEqual({ en: "second" })
  })

  test("an empty manifest yields an empty record", () => {
    expect(totalRecord([], (entry: { code: string }) => entry.code, () => 1)).toEqual({})
  })
})
