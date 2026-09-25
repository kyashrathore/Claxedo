import { describe, expect, test } from "bun:test"
import { acpGrantKey } from "./protocol"

describe("ACP grant identity", () => {
  test("an absent kind is other, never a wildcard", () => {
    expect(acpGrantKey(undefined, "Read file")).toBe(JSON.stringify(["other", "Read file"]))
    expect(acpGrantKey(undefined, "Read file")).not.toBe(acpGrantKey("read", "Read file"))
  })

  test("an untitled request cannot acquire a grant", () => {
    expect(acpGrantKey("read", undefined)).toBeUndefined()
    expect(acpGrantKey("read", "")).toBeUndefined()
  })

  test("a grant matches only its kind and exact title", () => {
    const key = acpGrantKey("read", "Read file")
    expect(key).not.toBe(acpGrantKey("edit", "Read file"))
    expect(key).not.toBe(acpGrantKey("read", "Read File"))
  })
})
