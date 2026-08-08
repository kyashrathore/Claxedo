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
  test("supplies a refresh-token exchange", () => {
    expect(source).toContain("refreshExchange")
    expect(source).toMatch(/refresh:\s*\(refreshToken\) =>/)
  })

  test("binds the refresh exchange to the configured client and token endpoint", () => {
    // A refresh posted to anything but the token endpoint the sign-in used, or
    // under a different client id, is rejected — and rejection on this path is
    // what signs the user out.
    expect(source).toMatch(/refresh\(\{\s*tokenUrl: config\.tokenUrl,\s*clientId: config\.clientId,\s*refreshToken\s*\}\)/)
  })
})
