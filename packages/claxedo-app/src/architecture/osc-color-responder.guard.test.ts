import { describe, expect, test } from "bun:test"
import path from "node:path"
import { CAPABILITY_RESPONDER_FILE, oscColorEscapesOutsideResponder, walkProdSources } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

// OSC 10/11 (terminal fg/bg color) query detection and their magic RGB response
// literals must live in exactly one production module. A dead duplicate that
// once lived in backend/xterm.ts was removed in Wave 1; this guard keeps it
// removed and forbids the escapes from reappearing anywhere else.

describe("OSC 10/11 single-owner guard", () => {
  test("no production file outside capability-responder.ts handles OSC 10/11 escapes", () => {
    const offenders = oscColorEscapesOutsideResponder(walkProdSources(appRoot)).map(
      (finding) => `${finding.file}:${finding.line}: OSC 10/11 handling belongs in ${CAPABILITY_RESPONDER_FILE}`,
    )

    expect(offenders).toEqual([])
  })

  test("flags an OSC 10/11 escape in another module and spares the canonical owner", () => {
    expect(
      oscColorEscapesOutsideResponder([
        { path: "features/terminal/core/backend/xterm.ts", text: `send("\\x1b]10;rgb:d4d4/d4d4/d4d4\\x07")` },
        { path: CAPABILITY_RESPONDER_FILE, text: `const q = /\\x1b\\]11;\\?/` },
      ]),
    ).toEqual([
      {
        file: "features/terminal/core/backend/xterm.ts",
        line: 1,
        match: "\\x1b]10;",
      },
    ])
  })

  test("matches both string-literal and regex-literal escape forms", () => {
    expect(
      oscColorEscapesOutsideResponder([
        { path: "a.ts", text: `"\\x1b]11;rgb:1c1c/1c1c/1c1c\\x07"` },
        { path: "b.ts", text: `/\\x1b\\]10;\\?(?:\\x1b\\\\|\\x07)/` },
      ]).map((finding) => finding.match),
    ).toEqual(["\\x1b]11;", "\\x1b\\]10;"])
  })

  test("does not flag unrelated OSC sequences (e.g. OSC 0 title, OSC 12 cursor color)", () => {
    expect(
      oscColorEscapesOutsideResponder([
        { path: "c.ts", text: `"\\x1b]0;window title\\x07"` },
        { path: "d.ts", text: `"\\x1b]12;green\\x07"` },
      ]),
    ).toEqual([])
  })
})
