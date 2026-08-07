import { describe, expect, test } from "bun:test"
import { staleProcessTerminalIds } from "./process-pane-cleanup"

describe("staleProcessTerminalIds", () => {
  test("returns only process-owned terminals absent from the current runtime", () => {
    expect(staleProcessTerminalIds(["pty_old", "pty_current"], new Set(["pty_current"]))).toEqual(new Set(["pty_old"]))
  })

  test("keeps unrelated current runtime terminals out of the stale set", () => {
    expect(staleProcessTerminalIds(["pty_owned"], new Set(["pty_owned", "pty_unowned"]))).toEqual(new Set())
  })
})
