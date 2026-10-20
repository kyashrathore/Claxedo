/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { isDestructiveIcon } from "./row-actions"

describe("isDestructiveIcon", () => {
  test("marks only the delete icon as destructive", () => {
    expect(isDestructiveIcon("delete")).toBe(true)
    expect(["refresh", "close", "edit", undefined].map(isDestructiveIcon)).toEqual([false, false, false, false])
  })
})
