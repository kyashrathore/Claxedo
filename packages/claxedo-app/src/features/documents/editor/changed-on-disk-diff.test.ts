import { describe, expect, test } from "bun:test"
import { unifiedChangedOnDiskDiff } from "./changed-on-disk-diff"

describe("changed-on-disk diff", () => {
  test("renders a bounded unified line diff with stable prefixes", () => {
    expect(unifiedChangedOnDiskDiff("one\ntwo\n", "one\nthree\n")).toEqual([
      { kind: "equal", text: " one\n" },
      { kind: "delete", text: "-two\n" },
      { kind: "insert", text: "+three\n" },
    ])
  })
})
