import { describe, expect, test } from "bun:test"
import { createCursorSdkDriver } from "./driver"

describe("Cursor SDK driver", () => {
  test("serves the static Cursor model catalog before any live listing", () => {
    const driver = createCursorSdkDriver({
      lifecycle: () => ({ set() {}, delete() {}, get() {}, activeTurns: new Map() }),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      bindSession() {},
    } as never)

    expect(driver.peekConfigOptions("gpt-5.5")).toEqual([
      expect.objectContaining({
        id: "model",
        currentValue: "gpt-5.5",
        selectOptions: expect.arrayContaining([
          expect.objectContaining({ id: "auto" }),
          expect.objectContaining({ id: "gpt-5.5" }),
        ]),
      }),
    ])
  })
})
