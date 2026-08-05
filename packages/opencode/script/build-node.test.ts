import { expect, test } from "bun:test"
import * as fs from "node:fs"
import { builtinModules } from "node:module"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Artifact-shape guards for the embedded engine (`dist/node/node.js`).
 *
 * The engine ships to the desktop app as a LONE FILE at
 * `Resources/opencode-engine/node.js`. Node resolves a bare import by walking
 * UP from the importing file, and that directory's ancestors contain no
 * `node_modules` — `Resources/app.asar.unpacked/node_modules` is a SIBLING.
 * So any unbundled dependency must be shipped beside the engine explicitly
 * (electron-builder.config.ts extraResources) or it cannot resolve at runtime.
 *
 * This failed silently in v0.0.64. `jsonc-parser` was marked external but never
 * shipped, and it is imported at the top level of the engine's config module,
 * so the ESM import threw and took the WHOLE engine down. Every engine-backed
 * route then degraded to its empty fallback: `/config/providers` answered
 * `{providers: []}` and the model picker rendered "No model results" — no
 * error dialog, no log the user could see, and every unit test still green
 * because tests run from a tree where `node_modules` IS reachable.
 *
 * These tests read the built artifact directly, so they see what ships.
 */

const DIST = path.resolve(import.meta.dir, "../dist/node")
const ARTIFACT = path.join(DIST, "node.js")

// Native modules cannot be bundled, so they are legitimately external — but
// each one MUST be shipped beside the engine. Keep this in lockstep with the
// extraResources entries in packages/claxedo-desktop/electron-builder.config.ts.
const SHIPPED_ALONGSIDE = new Set(["@lydell/node-pty"])

/**
 * Locate an installed package directory by name, falling back to a scan of
 * bun's version-pinned `node_modules/.bun/<name>@<version>/` store for
 * packages (like platform-specific optional deps) that are never symlinked
 * into a resolvable position.
 */
function findPackageDir(name: string) {
  try {
    return path.dirname(Bun.resolveSync(`${name}/package.json`, import.meta.dir))
  } catch {}
  const store = path.resolve(import.meta.dir, "../../../node_modules/.bun")
  if (!fs.existsSync(store)) return undefined
  const prefix = `${name.replace("/", "+")}@`
  for (const entry of fs.readdirSync(store)) {
    if (!entry.startsWith(prefix)) continue
    const candidate = path.join(store, entry, "node_modules", name)
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate
  }
  return undefined
}

function artifact() {
  if (!fs.existsSync(ARTIFACT)) {
    console.warn("[skip] dist/node/node.js missing — run `bun run script/build-node.ts` first")
    return undefined
  }
  return fs.readFileSync(ARTIFACT, "utf8")
}

test("every bare import left in the engine is one we ship beside it", () => {
  const code = artifact()
  if (!code) return

  // Static ESM imports that survived bundling, e.g. `import x from"pkg"`.
  // Anchored at line start and excluding `import type` so that package names
  // appearing inside string literals or embedded doc snippets (the engine
  // inlines plugin-authoring docs containing `import type { Plugin } from
  // "@opencode-ai/plugin"`) are not mistaken for real runtime imports.
  const bare = new Set<string>()
  for (const match of code.matchAll(/^import\s+(?!type\s)[^\n]*?from\s*"([^"]+)"/gm)) {
    const specifier = match[1]!
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue
    if (specifier.startsWith("node:")) continue
    bare.add(specifier)
  }

  // Node builtins resolve without node_modules, so they are always safe.
  const builtins = new Set(builtinModules)
  const risky = [...bare].filter((s) => !builtins.has(s) && !builtins.has(s.split("/")[0]!))

  const unshipped = risky.filter((s) => !SHIPPED_ALONGSIDE.has(s))
  expect(
    unshipped,
    `these packages are imported bare but are not shipped beside the engine, so they ` +
      `CANNOT resolve from Resources/opencode-engine/ in the packaged app — bundle them ` +
      `(remove from \`external\`) or add an extraResources entry AND list them in ` +
      `SHIPPED_ALONGSIDE:\n  ${unshipped.join("\n  ") || "(none)"}`,
  ).toEqual([])
})

test("no unresolvable dynamic requires survived bundling", () => {
  const code = artifact()
  if (!code) return

  // A relative `require("./…")` in bundled output points at a file that was
  // never emitted beside the artifact. jsonc-parser's UMD build shipped
  // `require("./impl/format")` this way: it bundles without error and throws
  // the moment the module is loaded.
  const relative = new Set<string>()
  for (const match of code.matchAll(/\brequire\d*\s*\(\s*"(\.[^"]*)"\s*\)/g)) relative.add(match[1]!)

  expect(
    [...relative],
    `bundled output contains relative require() calls whose targets were never ` +
      `emitted — these throw at runtime. Usually a dependency resolved to a UMD/CJS ` +
      `build; alias it to the package's ESM entry in build-node.ts:\n  ` +
      `${[...relative].join("\n  ") || "(none)"}`,
  ).toEqual([])
})

test("the built engine actually imports with no node_modules in scope", async () => {
  if (!fs.existsSync(ARTIFACT)) {
    console.warn("[skip] dist/node/node.js missing — run `bun run script/build-node.ts` first")
    return
  }

  // The decisive check, and the one that would have caught v0.0.64: copy the
  // artifact somewhere with NO node_modules on any ancestor path — the
  // packaged app's reality — and import it. Shape checks above can miss a new
  // failure mode; an actual import cannot.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-engine-load-"))
  try {
    const target = path.join(root, "node.js")
    fs.copyFileSync(ARTIFACT, target)
    // Sibling assets the engine loads at import time (tree-sitter/photon wasm).
    for (const entry of fs.readdirSync(DIST)) {
      if (entry.endsWith(".wasm")) fs.copyFileSync(path.join(DIST, entry), path.join(root, entry))
    }
    // Everything in SHIPPED_ALONGSIDE is placed beside the artifact, exactly as
    // extraResources does — so this proves the shipped layout, not a bare file.
    for (const pkg of SHIPPED_ALONGSIDE) {
      const from = path.dirname(Bun.resolveSync(`${pkg}/package.json`, import.meta.dir))
      const to = path.join(root, "node_modules", pkg)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.cpSync(from, to, { recursive: true, dereference: true })
      // node-pty style packages `require()` a platform-specific sibling that
      // is an optionalDependency — bun keeps it only under node_modules/.bun,
      // unlinked at any level a normal resolve would reach, so locate it on
      // disk rather than through resolution.
      const optional = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8")).optionalDependencies
      for (const dep of Object.keys(optional ?? {})) {
        if (!dep.endsWith(`${process.platform}-${process.arch}`)) continue
        const depFrom = findPackageDir(dep)
        if (!depFrom) continue
        fs.cpSync(depFrom, path.join(root, "node_modules", dep), { recursive: true, dereference: true })
      }
    }

    // Import in a real `node` child: Bun resolves differently, and `node` is
    // what the desktop utility process actually runs.
    const probe = Bun.spawn({
      cmd: [
        "node",
        "-e",
        `import(${JSON.stringify(target)}).then(()=>{console.log("LOADED")}).catch(e=>{console.error(e.message);process.exit(1)})`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ])

    expect(
      code === 0 && out.includes("LOADED"),
      `the packaged engine failed to import with no node_modules in scope — the ` +
        `packaged app would start with a dead engine and an empty model list:\n${err.slice(-1500)}`,
    ).toBe(true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
