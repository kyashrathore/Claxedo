import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * The Node composition is not deployed; the e2e suites and integration tests
 * boot it by path. Exporting any of it from the package entry would hand a
 * consumer a server this package does not ship.
 *
 * Read as source rather than by importing: importing the entry pulls the whole
 * control plane, and what is being asserted is the export list.
 */

const index = readFileSync(path.resolve(import.meta.dirname, "../../index.ts"), "utf8")

describe("the package's public entry", () => {
  test("exports nothing from the Node composition", () => {
    expect(index).not.toMatch(/deployments\/self-hosted-node\//)
    expect(index).not.toMatch(/\b(startServer|startSelfHostedServer|createSelfHostedApp|createApp)\b/)
  })

  test("the export scan is not vacuous", () => {
    const exported = index.match(/export \{[\s\S]*?\} from/g)?.join("\n") ?? ""

    expect(exported).toContain("createControlPlaneServices")
    expect(exported.length).toBeGreaterThan(200)
  })
})
