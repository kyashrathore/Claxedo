import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * What the Electron assembly actually hands the account service.
 *
 * `index.ts` imports electron and cannot be loaded in this process, so this
 * reads it — the same technique `electron-seams.test.ts` uses to pin the
 * loopback bind. Crude, and worth it here: the seam this checks was optional
 * for long enough that the production wiring simply never supplied it, which
 * made `refresh` API surface reachable only from a test fixture while every
 * real session died at its first access-token expiry. A unit test of the
 * service cannot see that, because the service was always the half that worked.
 */

/**
 * Comments stripped before matching, deliberately.
 *
 * A source-text guard that reads the raw file is satisfied by PROSE about the
 * code as readily as by the code. Six guards on this branch passed against
 * their own explanatory comments before anyone noticed, and this file is a
 * prime candidate: `index.ts` would very reasonably grow a comment explaining
 * why it supplies a refresh exchange, and that sentence alone would keep this
 * test green with the wiring deleted — the exact defect it exists to catch.
 */
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("setupAccount", () => {
  test("supplies refresh to the descriptor-selected native adapter", () => {
    expect(source).toContain("refreshExchange")
    expect(source).toMatch(/createDesktopNativeAuth\(\{[\s\S]*refresh: refreshExchange\(controlPlaneFetch\)/)
  })

  test("passes only the selected core origin, never baked provider details", () => {
    expect(source).toContain("coreOrigin: config.coreOrigin")
    expect(source).not.toMatch(/config\.(authorizeUrl|tokenUrl|clientId|scope)/)
  })

  test("identifies release-validation requests only at the selected core origin", () => {
    expect(source).toContain('new URL(next.url).origin !== config.coreOrigin')
    expect(source).toContain('headers.set("x-claxedo-multiplayer-validation-operation"')
    expect(source).toContain("fetch: controlPlaneFetch")
    expect(source).toContain("exchange: tokenExchange(controlPlaneFetch)")
    expect(source).toContain("refresh: refreshExchange(controlPlaneFetch)")
    expect(source).not.toContain("exchange: tokenExchange()")
    expect(source).not.toContain("refresh: refreshExchange()")
  })

  test("starts restore after Electron secure storage is ready without blocking renderer initialization", () => {
    const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    const lazy = readFileSync(new URL("./lazy-account.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
    const ready = entry.indexOf("app.whenReady().then")
    const restore = entry.indexOf("void account.ready.catch")
    const initialize = entry.indexOf("await initialize()")

    expect(entry).toContain("adapterReady: app.whenReady()")
    expect(lazy).toMatch(/loading \?\?= Promise\.resolve\(input\.adapterReady\)/)
    expect(ready).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(ready)
    expect(restore).toBeLessThan(initialize)
    expect(entry).not.toContain("await account.ready")
  })
})
