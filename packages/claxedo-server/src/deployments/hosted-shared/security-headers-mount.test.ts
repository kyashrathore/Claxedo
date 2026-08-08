/**
 * Where the hosted app mounts its security headers.
 *
 * Lives beside the composition it guards. The header POLICY moved to
 * `@claxedo/server-core` because both products apply it; this is about one
 * composition's mount order, which is this package's business.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

describe("hosted-app mounts the middleware outermost", () => {
  test("securityHeaders() is registered before the CORS middleware", () => {
    // Source-level ratchet, same idiom as architecture.test.ts's mount pins:
    // the guarantee is "no hosted route can miss these", which only holds if
    // the middleware is composed once, at the top, ahead of CORS.
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../deployments/hosted-shared/hosted-app.ts"), "utf-8")
    // The CORS *mount*, not `corsMiddleware`'s definition further up the file.
    const corsMount = source.indexOf("app.use(\n    corsMiddleware(")

    expect(source).toContain("app.use(securityHeaders())")
    expect(corsMount).toBeGreaterThan(-1)
    expect(source.indexOf("app.use(securityHeaders())")).toBeLessThan(corsMount)
  })
})
