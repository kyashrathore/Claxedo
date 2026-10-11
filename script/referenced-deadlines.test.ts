import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const packages = path.resolve(import.meta.dirname, "../packages")
const TEST_ONLY = /(?:^|\/)(?:test-support|__tests__|e2e)\/|\.(?:test|spec|vitest|typecheck|node-test)\.[cm]?tsx?$/
/**
 * Electron's main process runs on Node, which fires the unreferenced timer
 * `AbortSignal.timeout` arms; everywhere else may run on Bun for Windows.
 */
const NODE_ONLY = /^claxedo-desktop\/src\/main\//

test("a production deadline never rides on AbortSignal.timeout's unreferenced timer", () => {
  const files = readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const src = path.join(packages, entry.name, "src")
      try {
        return readdirSync(src, { recursive: true, encoding: "utf8" }).map((name) => `${entry.name}/src/${name.split(path.sep).join("/")}`)
      } catch {
        return []
      }
    })
    .filter((name) => /\.[cm]?tsx?$/.test(name) && !name.endsWith(".d.ts") && !TEST_ONLY.test(name) && !NODE_ONLY.test(name))
  expect(files.length).toBeGreaterThan(1_000)
  const offenders = files.filter((name) => readFileSync(path.join(packages, name), "utf8").includes("AbortSignal.timeout("))
  expect(offenders).toEqual([])
})
