import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

function code(file: URL) {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
}

const main = code(new URL("../index.ts", import.meta.url))
const broker = code(new URL("./lazy-account.ts", import.meta.url))

describe("lazy account production wiring", () => {
  test("base Electron main never statically imports the account adapter", () => {
    expect(main).not.toContain('from "./account/index"')
    expect(main).toContain('from "./account/lazy-account"')
    expect(broker).toContain('import("./index")')
  })

  test("restored account state does not gate the local renderer", () => {
    const ready = main.indexOf("void account.ready.catch")
    const initialize = main.indexOf("await initialize()", ready)
    expect(ready).toBeGreaterThan(-1)
    expect(initialize).toBeGreaterThan(ready)
    expect(main).not.toContain("await account.ready")
  })

  test("signed-to-unsigned suspends Host Connector publication, and a returning account resumes it", () => {
    expect(main).toMatch(/onStateChange:\s*\(next, previous\)\s*=>/)
    // The verdict is one owned function (`remoteAccessFollow`), so a transient
    // lapse holds and only a real sign-out suspends; both edges are wired.
    expect(main).toMatch(/remoteAccessFollow\(previous, next\)/)
    // Tolerant of the formatter breaking the optional-call across lines.
    expect(main).toMatch(/hostConnector\s*\?\.suspendForAuthLapse\(\)/)
    expect(main).toMatch(/hostConnector\s*\?\.resumeAfterAuthLapse\(\)/)
  })
})
