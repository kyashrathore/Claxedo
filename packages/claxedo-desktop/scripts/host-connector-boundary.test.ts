import { expect, test } from "bun:test"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

import { resolveLocalServerEntry } from "./local-server"
import { spec } from "./contract"

/**
 * Host Connector is an optional child, not part of either shipping closure.
 *
 * U8-R19 makes that a build property: the connector has its own manifest and
 * source graph, base unsigned launch neither starts nor imports it, and it is
 * fingerprinted separately. Two of those are checkable here, and the plan asks
 * for them to be VERIFIED rather than assumed — an import added to the server
 * entry or the renderer would put enrollment, relay transport, and a signing
 * identity inside the unsigned build with nothing to say so.
 *
 * The non-import claim is checked two ways, because neither alone is enough:
 *
 *   - The bundled server's real static import closure is WALKED. That is the
 *     graph `bundle-claxedo-server.ts` feeds to Bun, so its answer is the
 *     artifact's answer. The walk carries positive controls: it must reach the
 *     packages it is supposed to reach and leave nothing unresolved, or a
 *     walker that stopped at the first file would report "clean".
 *   - The renderer closure cannot be walked here — it crosses into
 *     `@claxedo/app`, whose `@/` aliases are Vite's to resolve. So its inputs
 *     are checked instead: the packages the renderer is composed from must
 *     neither declare nor import the connector anywhere.
 */

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")
const REPO_PACKAGES = path.resolve(PACKAGE_DIR, "..")
const CONNECTOR = "@claxedo/host-connector"

/** Import and re-export specifiers, with comments removed first. */
function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"\\])\/\/.*$/gm, "$1")
  const found: string[] = []
  const statics = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"();]*?\sfrom\s*)?["']([^"']+)["']/g
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  for (const match of code.matchAll(statics)) found.push(match[1]!)
  for (const match of code.matchAll(dynamic)) found.push(match[1]!)
  return found
}

type Closure = { files: Set<string>; packages: Set<string>; unresolved: string[] }

/** The static import closure of one entry file, following package edges. */
function walk(entry: string): Closure {
  const files = new Set<string>()
  const packages = new Set<string>()
  const unresolved: string[] = []
  const pending = [entry]

  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.has(file)) continue
    files.add(file)
    let source: string
    try {
      source = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const require = createRequire(file)
    for (const specifier of specifiers(source)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const base = path.resolve(path.dirname(file), specifier)
        const candidate = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}.js`].find(
          (option) => fs.existsSync(option) && fs.statSync(option).isFile(),
        )
        if (candidate) pending.push(candidate)
        else unresolved.push(`${specifier} (from ${file})`)
        continue
      }
      packages.add(specifier)
      // Only workspace packages are followed: node_modules cannot import a
      // private workspace package, and following them would walk all of npm.
      if (!specifier.startsWith("@claxedo/") && !specifier.startsWith("@opencode-ai/")) continue
      try {
        pending.push(require.resolve(specifier))
      } catch {
        unresolved.push(`${specifier} (from ${file})`)
      }
    }
  }

  return { files, packages, unresolved }
}

/** Every source file under a directory, minus tests. */
function sources(root: string, skip: (file: string) => boolean = () => false): string[] {
  const out: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()!
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name)
      if (item.isDirectory()) {
        if (item.name !== "node_modules" && !skip(full)) pending.push(full)
        continue
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(item.name)) continue
      if (/\.(test|spec|vitest)\.[jt]sx?$/.test(item.name)) continue
      if (skip(full)) continue
      out.push(full)
    }
  }
  return out
}

test("the separately built child entry imports the connector while its main assembly does not", () => {
  // Positive control for every negative assertion below. The executable owns
  // the implementation; the dependency-light Electron supervisor owns only
  // the fixed protocol and lifecycle.
  const childEntry = path.join(import.meta.dir, "host-connector-entry.ts")
  expect(
    specifiers(fs.readFileSync(childEntry, "utf8")).filter(
      (specifier) => specifier === CONNECTOR || specifier.startsWith(`${CONNECTOR}/`),
    ),
  ).toEqual(["@claxedo/host-connector/connector", "@claxedo/host-connector/host-identity"])

  const mainAssembly = walk(path.join(PACKAGE_DIR, "src/main/host-connector/electron-child.ts"))
  expect([...mainAssembly.packages].filter((name) => name === CONNECTOR || name.startsWith(`${CONNECTOR}/`))).toEqual([])
  expect([...mainAssembly.files].some((file) => file.endsWith("/host-connector/child-supervisor.ts"))).toBe(true)
})

test("the bundled local-server's import closure never reaches Host Connector", () => {
  const closure = walk(path.join(import.meta.dir, "claxedo-server-entry.ts"))

  // Positive controls first: the walk must have gone where the bundle goes.
  expect(closure.unresolved).toEqual([])
  expect(closure.files.has(resolveLocalServerEntry(PACKAGE_DIR))).toBe(true)
  expect([...closure.files].some((file) => file.includes("/claxedo-server-core/src/"))).toBe(true)
  expect(closure.files.size).toBeGreaterThan(100)

  const reached = [...closure.packages].filter((s) => s === CONNECTOR || s.startsWith(`${CONNECTOR}/`))
  expect(reached).toEqual([])
})

test("no package the renderer is composed from declares or imports Host Connector", () => {
  // The renderer bundle is built from the desktop's own renderer/preload plus
  // `@claxedo/app` and the shared UI packages. If the specifier appears in
  // none of them, no Vite alias can route to it either.
  const trees = [
    path.join(PACKAGE_DIR, "src/renderer"),
    path.join(PACKAGE_DIR, "src/preload"),
    path.join(PACKAGE_DIR, "src/shared"),
    path.join(REPO_PACKAGES, "claxedo-app/src"),
    path.join(REPO_PACKAGES, "ui/src"),
  ].filter((tree) => fs.existsSync(tree))

  expect(trees.length).toBe(5)

  const importers = trees
    .flatMap((tree) => sources(tree))
    .filter((file) =>
      specifiers(fs.readFileSync(file, "utf8")).some((s) => s === CONNECTOR || s.startsWith(`${CONNECTOR}/`)),
    )

  expect(importers).toEqual([])

  // And no manifest edge, so a future `@/`-aliased import could not resolve.
  for (const manifest of ["claxedo-app/package.json", "ui/package.json"]) {
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO_PACKAGES, manifest), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(Object.keys({ ...parsed.dependencies, ...parsed.devDependencies }), manifest).not.toContain(CONNECTOR)
  }
})

test("Host Connector is fingerprinted separately in the desktop build contract", () => {
  // It ships in the same artifact without being in either closure, so nothing
  // else would notice it changing. `input` is a relative-path list, so compare
  // resolved directories rather than strings.
  const built = spec(PACKAGE_DIR)
  const inputs = new Set(built.input.map((entry) => path.resolve(PACKAGE_DIR, entry)))
  const connectorDir = path.join(REPO_PACKAGES, "claxedo-host-connector")

  expect(inputs.has(path.join(connectorDir, "src"))).toBe(true)
  expect(inputs.has(path.join(connectorDir, "package.json"))).toBe(true)
})
