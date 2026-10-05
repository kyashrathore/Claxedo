import { describe, expect, test } from "bun:test"
import { chunkLoadRecovery, isModuleLoadFailure } from "./lazy-view"

const BUILD = "https://app.example/assets/main-BX0K_iOo.js"

describe("module load failures", () => {
  test("the browser's fetch failures for a module are TypeErrors", () => {
    expect(isModuleLoadFailure(new TypeError("Failed to fetch dynamically imported module: https://app.example/assets/terminal-creator-CnDRifPk.js"))).toBe(true)
    expect(isModuleLoadFailure(new TypeError("Importing a module script failed."))).toBe(true)
    expect(isModuleLoadFailure(new TypeError("error loading dynamically imported module: https://app.example/assets/x.js"))).toBe(true)
  })

  test("HTML served in place of a module parses as a SyntaxError", () => {
    expect(isModuleLoadFailure(new SyntaxError("Unexpected token '<'"))).toBe(true)
  })

  test("a plain error or a thrown string is a view failure, not a module load failure", () => {
    expect(isModuleLoadFailure(new Error("boom"))).toBe(false)
    expect(isModuleLoadFailure("string")).toBe(false)
  })
})

describe("chunk load recovery", () => {
  test("the first failure on a build reloads the page", () => {
    expect(chunkLoadRecovery({ error: new SyntaxError("Unexpected token '<'"), buildId: BUILD, reloadedFor: null })).toBe("reload")
    expect(chunkLoadRecovery({ error: new SyntaxError("Unexpected token '<'"), buildId: BUILD, reloadedFor: "https://app.example/assets/main-OLD.js" })).toBe("reload")
  })

  test("a failure on the build the page already reloaded for reports a stale build instead of looping", () => {
    expect(chunkLoadRecovery({ error: new TypeError("Importing a module script failed."), buildId: BUILD, reloadedFor: BUILD })).toBe("stale")
  })

  test("a document with no hashed entry cannot tell builds apart, so it reports rather than reloads", () => {
    expect(chunkLoadRecovery({ error: new SyntaxError("Unexpected token '<'"), buildId: undefined, reloadedFor: null })).toBe("stale")
  })

  test("other errors pass through untouched", () => {
    const error = new Error("view threw")
    expect(chunkLoadRecovery({ error, buildId: BUILD, reloadedFor: null })).toBe("rethrow")
  })
})
