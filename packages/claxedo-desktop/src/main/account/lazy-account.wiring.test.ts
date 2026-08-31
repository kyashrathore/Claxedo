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

  test("a signed-to-unsigned transition pauses Host Connector publication", () => {
    expect(main).toMatch(/onStateChange:\s*\(next, previous\)\s*=>/)
    expect(main).toMatch(/previous\.status === "signed" && next\.status !== "signed"\) hostConnector\?\.stop\(\)/)
  })
})
