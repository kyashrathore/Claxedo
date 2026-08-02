import { describe, expect, test } from "bun:test"
import { shouldMountTerminalPane } from "./terminal-content-policy"

describe("terminal content mount policy", () => {
  test("keeps never-activated hidden terminal panes from reconnecting on reload", () => {
    expect(shouldMountTerminalPane({ visible: false, ptyReady: true, activated: false })).toBe(false)
  })

  test("mounts the websocket terminal when the pane is visible and ready", () => {
    expect(shouldMountTerminalPane({ visible: true, ptyReady: true, activated: false })).toBe(true)
    expect(shouldMountTerminalPane({ visible: true, ptyReady: false, activated: false })).toBe(false)
  })

  test("keeps activated live terminal panes mounted while hidden for fast switching", () => {
    expect(shouldMountTerminalPane({ visible: false, ptyReady: true, activated: true })).toBe(true)
  })
})
