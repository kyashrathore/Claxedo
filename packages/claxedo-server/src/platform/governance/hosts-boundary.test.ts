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

/** Module paths under `src/`, spelled with `/` on every platform so an edge reads the same in any report. */
function modulePath(file: string) {
  return path.relative(SRC, file).split(path.sep).join("/")
}

function deploymentImports(file: string, text: string) {
  return [...text.matchAll(RELATIVE_IMPORT)]
    .map((match) => modulePath(path.resolve(path.dirname(file), match[1])))
    .filter((target) => target.startsWith("deployments/"))
    .map((target) => `${modulePath(file)} -> ${target}`)
}

describe("hosts boundary", () => {
  test("the check is not vacuous — hosts/ exists and holds production files", () => {
    // `hosts/workspace-runtime/` is the only host directory. The floor is here
    // so an empty or moved directory cannot make every assertion below pass by
    // scanning nothing.
    expect(hostFiles().length).toBeGreaterThanOrEqual(5)
  })

  test("the deployment-import detector names the edge it is looking for", () => {
    // Planted, because every assertion below is an empty list: a detector that
    // matched nothing at all would pass them all and report a clean boundary
    // while an edge walked in.
    expect(deploymentImports(
      path.join(HOSTS, "workspace-runtime/session-env.ts"),
      'import { createSelfHostedApp } from "../../deployments/self-hosted-node/app"',
    )).toEqual(["hosts/workspace-runtime/session-env.ts -> deployments/self-hosted-node/app"])
    expect(deploymentImports(
      path.join(HOSTS, "workspace-runtime/session-env.ts"),
      'import { peer } from "../../platform/http/peer-address"',
    )).toEqual([])
  })

  test("no production file under hosts/ imports a deployment", () => {
    const offenders = hostFiles().flatMap((file) => deploymentImports(file, fs.readFileSync(file, "utf8")))

    // A host reaching into a deployment makes the reusable half depend on one
    // runtime. If a host genuinely needs something a deployment owns, either
    // lift the shared part into platform/ or inject it at the composition root.
    expect(offenders.toSorted()).toEqual([])
  })

  test("the external-composition detector separates a host from domain code", () => {
    expect(EXTERNAL_CLAXEDO.test('import { startServer } from "@claxedo/workspace-runtime"')).toBe(true)
    expect(EXTERNAL_CLAXEDO.test('import { thing } from "../../platform/runtime/lib/log"')).toBe(false)
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
    // drifted in rather than composing an external host capability.
    expect(offenders.toSorted()).toEqual([])
  })
})
