import { createRoot } from "solid-js"
import { describe, expect, test } from "vitest"
import { useOptionalTerminal, useTerminal } from "./terminal"

describe("terminal context", () => {
  test("optional terminal hook returns undefined outside the provider", () => {
    let value: ReturnType<typeof useOptionalTerminal> | "unset" = "unset"
    createRoot((dispose) => {
      value = useOptionalTerminal()
      dispose()
    })

    expect(value).toBeUndefined()
  })

  test("required terminal hook throws outside the provider", () => {
    expect(() =>
      createRoot((dispose) => {
        useTerminal()
        dispose()
      }),
    ).toThrow("Terminal context must be used within a context provider")
  })
})
