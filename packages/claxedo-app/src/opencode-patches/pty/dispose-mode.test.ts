import { describe, expect, test } from "bun:test"
import { disposeMode } from "./dispose-mode"

describe("disposeMode", () => {
  test("removes live non-managed PTYs during instance disposal", () => {
    expect(disposeMode({ managed: false, exited: false })).toBe("remove")
  })

  test("keeps managed PTYs in non-destructive exit mode", () => {
    expect(disposeMode({ managed: true, exited: false })).toBe("exit")
  })

  test("keeps already-exited PTYs in exit mode", () => {
    expect(disposeMode({ managed: false, exited: true })).toBe("exit")
  })
})
