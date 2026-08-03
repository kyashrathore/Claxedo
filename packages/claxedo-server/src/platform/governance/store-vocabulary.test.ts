/**
 * `store` means one thing: a module that persists and reads a domain's own
 * data.
 *
 * The word had drifted onto five different jobs, so "where is the X store?"
 * stopped having an answer. The rule this pins:
 *
 *   <domain>/store.ts        own persistence            (workspace, billing)
 *   <domain>/<thing>-store.ts  persistence for one thing  (documents/index-store)
 *   *-adapter / adapters/*   an EXTERNAL port implementation
 *
 * A module that selects between backends, or holds a process-global handle, is
 * a registry — not a store. `credentials/store.ts` exported `getBackend()` and
 * `setBackendOverride()` and persisted nothing; it is now `backend-registry.ts`.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")

/**
 * Holding state, in any of the three shapes this codebase uses: a SQL/drizzle
 * call, an in-memory collection (`supervisor/store.ts` is a `Map` of live
 * runtimes), or the TYPE of a store port whose implementations live elsewhere
 * (`projection-store.ts`, `central-store.ts`).
 *
 * Deliberately broad. The defect being caught is a module named `store` that
 * holds NOTHING — a backend selector or a config wrapper — so the test only has
 * to separate "state lives here" from "no state anywhere in sight".
 */
const HOLDS_STATE =
  /\b(?:db|database)\b|drizzle|\.prepare\(|SELECT |INSERT |UPDATE |\bquery\(|\bmutation\(|ClaxedoDB|new Map\b|new Set\b|\bsync_|\bput_|\bget_|Store = \{|Store = Readonly/

function storeModules() {
  return walk(SRC)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => /(?:^|[-/])store\.ts$|-store\.ts$/.test(file))
}

describe("store vocabulary", () => {
  test("the check is not vacuous — store modules exist", () => {
    expect(storeModules().length).toBeGreaterThan(5)
  })

  test("every module named store actually persists something", () => {
    const offenders = storeModules()
      .filter((file) => !HOLDS_STATE.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file))

    // A file here holds a handle, selects a backend, or wraps config. Those are
    // registries and factories; naming them `store` sends a reader looking for
    // persistence that is not there.
    expect(offenders.toSorted()).toEqual([])
  })
})
