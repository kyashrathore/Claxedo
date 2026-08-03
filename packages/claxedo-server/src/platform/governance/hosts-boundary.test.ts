/**
 * `hosts/` composes external `@claxedo/*` packages, and never imports a
 * deployment.
 *
 * The layering: `deployments/` are the composition roots — they pick a runtime
 * (local Node, hosted Worker) and wire everything together. `hosts/` sits below
 * them, adapting an external package into this server. An import pointing the
 * other way inverts that: the reusable half depends on one particular
 * deployment, so the OTHER deployment either drags that module into its bundle
 * or breaks.
 *
 * That is not hypothetical here. `worker.import-graph.test.ts` maintains a list
 * of local-only modules that must not reach the Worker graph, and one of the
 * three violations this guard now bans
 * (`session-env.ts` -> `deployments/local/embedded-workspace-runtime`) was
 * exactly such an edge, held in check only by that separate test.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { walk } from "../../test-support/guards"

const SRC = path.resolve(import.meta.dirname, "../..")
const HOSTS = path.join(SRC, "hosts")

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.\.?\/[^"']+)["']/g

/**
 * Deliberately NOT global. A `/g` regex reused across `.test()` calls carries
 * `lastIndex` between them and starts the next search mid-file, so it reports
 * "no match" for files that do match — which here would silently pass a
 * drifted directory.
 */
const EXTERNAL_CLAXEDO = /from\s*["']@claxedo\/[^"']+["']/

function hostFiles(includeTests = false) {
  return walk(HOSTS).filter(
    (file) => file.endsWith(".ts") && (includeTests || !file.endsWith(".test.ts")),
  )
}

describe("hosts boundary", () => {
  test("the check is not vacuous — hosts/ exists and holds production files", () => {
    expect(hostFiles().length).toBeGreaterThan(10)
  })

  test("no production file under hosts/ imports a deployment", () => {
    const offenders = hostFiles().flatMap((file) => {
      const text = fs.readFileSync(file, "utf8")
      return [...text.matchAll(RELATIVE_IMPORT)]
        .map((match) => path.relative(SRC, path.resolve(path.dirname(file), match[1]!)))
        .filter((target) => target.split(path.sep)[0] === "deployments")
        .map((target) => `${path.relative(SRC, file)} -> ${target}`)
    })

    // A host reaching into a deployment makes the reusable half depend on one
    // runtime. If a host genuinely needs something a deployment owns, either
    // lift the shared part into platform/ or inject it at the composition root.
    expect(offenders.toSorted()).toEqual([])
  })

  test("every hosts/ subdirectory composes at least one external @claxedo package", () => {
    const offenders = fs
      .readdirSync(HOSTS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => {
        const dir = path.join(HOSTS, entry.name)
        return !walk(dir)
          .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
          .some((file) => EXTERNAL_CLAXEDO.test(fs.readFileSync(file, "utf8")))
      })
      .map((entry) => entry.name)

    // A directory here composes nothing external, so it is domain code that
    // drifted in — `agent-extensions/{catalog,scan,machine-scan}.ts` were
    // exactly that, and moved to agent-config/ where their consumer lives.
    expect(offenders.toSorted()).toEqual([])
  })
})
