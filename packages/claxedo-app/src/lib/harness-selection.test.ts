/// <reference types="bun" />
import { expect, test } from "bun:test"
import { connectionHarness, nativeHarness, runsInSessionHost } from "./harness-selection"

test("only Pi runs in the session host; every sandbox harness and every connection runs on the workspace machine", () => {
  expect(runsInSessionHost(nativeHarness("pi"))).toBe(true)
  for (const id of ["claude", "codex", "cursor", "opencode"] as const) expect(runsInSessionHost(nativeHarness(id)), id).toBe(false)
  expect(runsInSessionHost(connectionHarness("pi"))).toBe(false)
  expect(runsInSessionHost(undefined)).toBe(false)
})
