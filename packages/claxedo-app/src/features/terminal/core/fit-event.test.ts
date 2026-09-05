import { describe, expect, test } from "bun:test"
import { TERMINAL_FIT_EVENT } from "./fit-event"
import { FIT_EVENT } from "../workbench/terminal-fit"

// Prod code intentionally keeps two copies of this literal: `TERMINAL_FIT_EVENT`
// (features/terminal/core/fit-event.ts) and the canonical `FIT_EVENT`
// (features/terminal/workbench/terminal-fit.ts). The two constants are welded
// together here, in a test file (exempt from the layering scan per
// walkProdSources in src/architecture/scanners.ts, which filters out *.test.*
// files), so the literal cannot drift between them.
describe("terminal-fit event literal parity", () => {
  test("src/terminal's local TERMINAL_FIT_EVENT stays byte-identical to claxedo-ui's canonical FIT_EVENT", () => {
    expect(TERMINAL_FIT_EVENT).toBe(FIT_EVENT)
  })
})
