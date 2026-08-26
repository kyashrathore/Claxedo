import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { allImportSpecifiers, importSpecifiers, resolveImport, stripComments } from "./import-graph"
import { prodSourcePaths } from "./scanners"

/**
 * The hosted-contribution lifecycle, and the two ends it has to stay attached
 * to.
 *
 * `platform/account/hosted-contribution-port.ts` can remove a hosted
 * contribution set. That is only worth anything if something CALLS it, and this
 * is precisely the failure class the repository has shipped before: WorkGraph's
 * live-sync doorbell declared a ports seam that nothing ever configured, and
 * the whole feature ran inert with a green suite
 * (`app-ports-wiring.guard.test.ts` records it). A deactivation seam nobody
 * drives fails the same way and is even quieter — nothing is missing on screen,
 * a signed-out window simply keeps rendering hosted surfaces.
 *
 * So three properties, and each is a thing a future edit can silently undo:
 *
 *  1. The port stays a MECHANISM. It is import-free, so it cannot grow an edge
 *     into app code and cannot stop being movable.
 *  2. Exactly one module BINDS it, at the one place that owns both the
 *     contribution vocabulary and the registry.
 *  3. The composition DRIVES it — the account-following component is mounted,
 *     and the entry hands in the `unregister` half without which deactivation
 *     removes nothing.
 *
 * Everything below is scanned over resolved import specifiers or over
 * comment-stripped code. This file's own prose names every symbol it checks; a
 * raw-text scan would match itself and pass forever.
 */

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

const PORT = "platform/account/hosted-contribution-port.ts"
const BINDING = "app/composition/product-contributions.ts"
const DRIVER = "app/composition/hosted-contribution-sync.tsx"
const ENTRY = "app/entry/index.tsx"
const SHELL = "app/entry/app.tsx"

function source(module: string) {
  return readFileSync(path.join(srcRoot, module), "utf8")
}

function code(module: string) {
  return stripComments(source(module))
}

function modules() {
  return prodSourcePaths(appRoot).map((file) => path.relative(srcRoot, file).split(path.sep).join("/"))
}

/** Every module whose imports resolve to `target`, by importer. */
function importersOf(root: string, target: string) {
  const rootSrc = path.join(root, "src")
  const wanted = path.join(rootSrc, target)
  const found: string[] = []
  for (const file of prodSourcePaths(root)) {
    const from = path.relative(rootSrc, file).split(path.sep).join("/")
    if (from === target) continue
    const hit = allImportSpecifiers(readFileSync(file, "utf8")).some(
      (specifier) => resolveImport(root, file, specifier) === wanted,
    )
    if (hit) found.push(from)
  }
  return found.toSorted()
}

function fixtureApp(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "claxedo-hosted-contribution-"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", exports: {} }))
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, "src", rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

describe("the importer scanner", () => {
  // Positive controls. Every "the list is exactly this" assertion below proves
  // nothing if the scanner cannot see an edge in the first place.

  test("reports an aliased import of the port", () => {
    const root = fixtureApp({
      [PORT]: `export function createHostedContributionPort() {}\n`,
      "app/composition/binding.ts": `import { createHostedContributionPort } from "@/platform/account/hosted-contribution-port"\nexport const b = createHostedContributionPort\n`,
    })
    try {
      expect(importersOf(root, PORT)).toEqual(["app/composition/binding.ts"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports a relative and a type-only import too", () => {
    const root = fixtureApp({
      [PORT]: `export type HostedContributionPort = { active(): boolean }\n`,
      "platform/account/neighbour.ts": `import type { HostedContributionPort } from "./hosted-contribution-port"\nexport type P = HostedContributionPort\n`,
    })
    try {
      expect(importersOf(root, PORT)).toEqual(["platform/account/neighbour.ts"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not mistake prose about the port for an import of it", () => {
    const root = fixtureApp({
      [PORT]: `export function createHostedContributionPort() {}\n`,
      "app/composition/binding.ts": `// See @/platform/account/hosted-contribution-port for the lifecycle.\nconst note = "@/platform/account/hosted-contribution-port"\nexport const n = note\n`,
    })
    try {
      expect(importersOf(root, PORT)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("the port is a mechanism, not an implementation", () => {
  test("it imports nothing at all", () => {
    // Import-free the way `account-port.ts` is. It is also the reason it is
    // GENERIC: naming `ContentSurfaceContribution` would mean importing app
    // code from `platform/`, which `ownership.ts` forbids, and re-declaring
    // that shape here would create a second contract that drifts.
    expect(allImportSpecifiers(source(PORT))).toEqual([])
  })

  test("it is generic over an id-bearing contribution, not over a content surface", () => {
    // The generic parameter is the whole reason the layer boundary holds. If it
    // is ever specialised, the port either imports app code or duplicates the
    // app's type — both of which this file exists to prevent.
    expect(code(PORT)).toMatch(/export function createHostedContributionPort<T extends \{ id: string \}>/)
  })
})

describe("the port is bound in exactly one place", () => {
  test("only the product composition creates one", () => {
    const creators = modules()
      .filter((module) => module !== PORT)
      .filter((module) => /\bcreateHostedContributionPort\s*[(<]/.test(code(module)))
      .toSorted()

    // A second creator is a build whose hosted set has two owners, and whose
    // "at most once" is only true per owner.
    expect(creators).toEqual([BINDING])
  })

  test("and nothing else imports it", () => {
    expect(importersOf(appRoot, PORT)).toEqual([BINDING])
  })
})

describe("the composition drives it", () => {
  test("the shell mounts the account-following driver", () => {
    // Without this the port can remove a hosted set and nothing ever asks it
    // to: signing out would leave every hosted surface registered until the
    // page reloaded, which is the defect the port was added for.
    expect(importersOf(appRoot, DRIVER)).toEqual([SHELL])
    expect(code(SHELL)).toMatch(/<HostedContributionSync\s*\/>/)
  })

  test("the driver reads the account port and hands the state to the composition", () => {
    const specifiers = importSpecifiers(source(DRIVER))

    expect(specifiers).toContain("@/platform/account/account-provider")
    // The driver is a two-phase effect: the compute reads the port, the effect
    // phase hands what it read to the composition. Binding the effect
    // parameter back to the compute's value is what proves the state actually
    // flows through — matching the two names separately would not.
    expect(code(DRIVER)).toMatch(
      /createEffect\(\s*\(\)\s*=>\s*account\.state\(\),\s*\((\w+)\)\s*=>\s*contributions\.followAccount\(\1\),?\s*\)/,
    )
  })

  test("the entry binds the removal half, not only the registration half", () => {
    // `unregister` is what deactivation calls. A composition configured without
    // it type-checks nowhere — but a composition that passes a no-op, or that
    // stops importing the registry's remover, would deactivate into the void.
    const entry = code(ENTRY)

    expect(importSpecifiers(source(ENTRY))).toContain("@/app/integrations/first-party-content-surfaces")
    expect(entry).toMatch(/unregister:\s*unregisterContentSurface/)
    expect(entry).toMatch(/register:\s*registerContentSurface/)
  })

  test("the registry can actually remove a surface", () => {
    // The end of the chain. `addSurface` had no counterpart, so before this the
    // only way to un-register anything was to reload the page.
    expect(code("app/integrations/registry.ts")).toMatch(/removeSurface\s*\(\s*id:\s*string\s*\)/)
    expect(code("app/integrations/first-party-content-surfaces.tsx")).toMatch(
      /export function unregisterContentSurface/,
    )
  })
})
