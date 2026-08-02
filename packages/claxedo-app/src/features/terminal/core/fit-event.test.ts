import { describe, expect, test } from "bun:test"
import { TERMINAL_FIT_EVENT } from "./fit-event"
import { FIT_EVENT } from "../workbench/terminal-fit"

// Prod code intentionally keeps two copies of this literal: helpers.ts's own
// `TERMINAL_FIT_EVENT` (src/terminal/fit-event.ts) and the canonical
// `FIT_EVENT` (src/claxedo-ui/terminal/terminal-fit.ts). Importing FIT_EVENT
// directly from src/terminal/** would create a new claxedo-ui<->terminal
// import-graph edge not present in src/architecture/layering-baseline.json,
// so the two constants are welded together here instead, in a test file
// (exempt from the layering scan per walkProdSources in
// src/architecture/scanners.ts, which filters out *.test.* files).
describe("terminal-fit event literal parity", () => {
  test("src/terminal's local TERMINAL_FIT_EVENT stays byte-identical to claxedo-ui's canonical FIT_EVENT", () => {
    expect(TERMINAL_FIT_EVENT).toBe(FIT_EVENT)
  })
})
