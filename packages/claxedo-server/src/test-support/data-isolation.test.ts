import { existsSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, expect, test } from "vitest"
import { dataDir, stateDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { ClaxedoDB } from "../platform/db"

/**
 * Asserted against the resolvers the stores call, not against the variables
 * `data-isolation.ts` assigns: only the resolver proves the redirect reaches
 * the path a database is actually opened at.
 */
function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const home = os.homedir()
const temporary = realpathSync(os.tmpdir())

afterAll(() => ClaxedoDB.close())

test("every data root a store resolves stays in temporary storage outside the real application profiles", () => {
  for (const resolved of [dataDir(), stateDir(), ClaxedoDB.Path()]) {
    for (const profile of [".claxedo", ".workspace-runtime"]) {
      expect(contains(path.join(home, profile), resolved)).toBe(false)
    }
    expect({ resolved, inTemporary: contains(temporary, resolved) }).toEqual({ resolved, inTemporary: true })
  }
})

test("opening the database creates the file under the temporary root", () => {
  ClaxedoDB.raw()

  const opened = ClaxedoDB.Path()
  expect(existsSync(opened)).toBe(true)
  expect(contains(temporary, opened)).toBe(true)
})
