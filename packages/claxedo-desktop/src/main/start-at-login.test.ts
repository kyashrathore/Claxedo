import { describe, expect, test } from "bun:test"
import { createStartAtLogin } from "./start-at-login"

describe("desktop start at login", () => {
  test("reads and writes the Electron login item without inventing a daemon", () => {
    const writes: unknown[] = []
    let enabled = false
    const startAtLogin = createStartAtLogin({
      getLoginItemSettings: () => ({ openAtLogin: enabled }),
      setLoginItemSettings: (settings) => {
        writes.push(settings)
        enabled = settings.openAtLogin
      },
    })

    expect(startAtLogin.get()).toBe(false)
    startAtLogin.set(true)
    expect(startAtLogin.get()).toBe(true)
    expect(writes).toEqual([{ openAtLogin: true }])
  })
})
