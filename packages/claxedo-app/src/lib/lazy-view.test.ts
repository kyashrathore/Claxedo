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
  const OLD = "https://app.example/assets/main-OLD.js"
  const failure = new TypeError("Failed to fetch dynamically imported module: https://app.example/assets/x.js")

  test("a failure while the server serves a newer build reloads the page once for that build", () => {
    expect(chunkLoadRecovery({ error: new SyntaxError("Unexpected token '<'"), loadedBuild: OLD, servedBuild: BUILD, reloadedFor: null })).toBe("reload")
    expect(chunkLoadRecovery({ error: failure, loadedBuild: OLD, servedBuild: BUILD, reloadedFor: OLD })).toBe("reload")
  })

  test("a page that reloaded for the served build and still runs the old one reports a stale build instead of looping", () => {
    expect(chunkLoadRecovery({ error: failure, loadedBuild: OLD, servedBuild: BUILD, reloadedFor: BUILD })).toBe("stale")
  })

  test("a failure while the server serves this very build is the view's own error, never a reload", () => {
    expect(chunkLoadRecovery({ error: failure, loadedBuild: BUILD, servedBuild: BUILD, reloadedFor: null })).toBe("rethrow")
  })

  test("a build that cannot be told apart, on either side, is reported rather than reloaded", () => {
    expect(chunkLoadRecovery({ error: failure, loadedBuild: undefined, servedBuild: BUILD, reloadedFor: null })).toBe("rethrow")
    expect(chunkLoadRecovery({ error: failure, loadedBuild: OLD, servedBuild: undefined, reloadedFor: null })).toBe("rethrow")
  })

  test("other errors pass through untouched", () => {
    expect(chunkLoadRecovery({ error: new Error("view threw"), loadedBuild: OLD, servedBuild: BUILD, reloadedFor: null })).toBe("rethrow")
  })
})
