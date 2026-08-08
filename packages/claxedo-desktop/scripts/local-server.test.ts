import { expect, test } from "bun:test"
import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"

import {
  LOCAL_SERVER_ENTRY,
  localServerBundleEntry,
  localServerPackageDir,
  resolveLocalServerEntry,
  resolveLocalServerMigrationJournal,
} from "./local-server"

/**
 * The desktop's server, resolved once.
 *
 * These assert on RESOLVED VALUES, never on file text. The guard this replaces
 * checked that `prebuild.ts` contained the string `"../claxedo-local-server"`
 * — which it did, in a `const` nothing read. The path was correct and dead;
 * the test could not tell the difference.
 */

const PACKAGE_DIR = path.resolve(import.meta.dir, "..")

test("the declared entry resolves to a file inside the local-server package", () => {
  const entry = resolveLocalServerEntry(PACKAGE_DIR)

  expect(fs.existsSync(entry)).toBe(true)
  expect(entry.startsWith(localServerPackageDir(PACKAGE_DIR) + path.sep)).toBe(true)
})

test("the server child, development, and production preparation resolve ONE entry", () => {
  // Each caller resolves through this module, so agreement is structural
  // rather than coincidental — but the child's import is a literal in another
  // file, and that literal is what actually runs. Resolve it independently and
  // compare the files, so a renamed subpath in either place fails here.
  const childSource = fs.readFileSync(path.join(import.meta.dir, "claxedo-server-entry.ts"), "utf8")
  const imported = childSource.match(/^import\s*\{[^}]*\}\s*from\s*"(@claxedo\/local-server[^"]*)"/m)?.[1]

  expect(imported).toBe(LOCAL_SERVER_ENTRY)

  const require = createRequire(path.join(PACKAGE_DIR, "package.json"))
  expect(require.resolve(imported!)).toBe(resolveLocalServerEntry(PACKAGE_DIR))
})

test("an unresolvable local-server names the package, and offers no other server", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-no-local-server-"))
  try {
    fs.writeFileSync(path.join(empty, "package.json"), "{}\n")

    expect(() => resolveLocalServerEntry(empty)).toThrow(LOCAL_SERVER_ENTRY)
    expect(() => resolveLocalServerEntry(empty)).toThrow(/no fallback server/)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
  }
})

test("the migration journal is the directory local-server's own db module reads", () => {
  const journal = resolveLocalServerMigrationJournal(PACKAGE_DIR)

  expect(fs.existsSync(journal)).toBe(true)
  expect(fs.readdirSync(journal).length).toBeGreaterThan(0)

  // The runtime authority: `journal.ts` computes
  // `import.meta.dirname/claxedo-migration`. Resolve that module the way the
  // bundled server's own import graph does — from the local-server entry — and
  // require the bundler to copy exactly that directory. A `../../` path into a
  // sibling source tree keeps resolving after the dependency edge moves; this
  // cannot.
  const fromServer = createRequire(resolveLocalServerEntry(PACKAGE_DIR))
  const journalModule = fromServer.resolve("@claxedo/server-core/platform/db/journal")

  expect(journal).toBe(path.join(path.dirname(journalModule), "claxedo-migration"))
  expect(fs.readFileSync(journalModule, "utf8")).toContain(`path.join(import.meta.dirname, "claxedo-migration")`)
})

test("the bundler asks local-server for the journal instead of reaching across packages", () => {
  // Behaviourally these look identical today — the resolver and the old
  // `../../claxedo-server-core/src/platform/db/claxedo-migration` name the same
  // directory — so only the ROUTE distinguishes them, and the route is the
  // whole point: the relative path keeps resolving after local-server's db
  // dependency moves, and ships a bundle whose database has no tables.
  //
  // Comments are dropped line-wise; the block-comment regex would treat the
  // `/^jsonc-parser$/` literal and this file's own globs as comment delimiters.
  const code = fs
    .readFileSync(path.join(import.meta.dir, "bundle-claxedo-server.ts"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n")

  expect(code).toContain("const migrationsSource = resolveLocalServerMigrationJournal()")
  // And no surviving reach into a sibling package's source tree.
  expect(code).not.toMatch(/\.\.\/\.\.\/claxedo-/)
})

test("the production build refuses to start without the local-server bundle", async () => {
  // Run the real `build.ts` against a root that has no bundle. It is a
  // self-contained script over node builtins, so a copied scripts/ directory
  // IS the production path — `root` is computed from its own location.
  //
  // The failure it replaces was silent: electron.vite's copy plugin skips when
  // `resources/claxedo-server` is absent, so the build produced an app whose
  // server simply was not there and the contract later complained about a
  // "missing path" in out/.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-build-gate-"))
  try {
    fs.mkdirSync(path.join(root, "scripts"))
    for (const file of ["build.ts", "contract.ts", "local-server.ts", "utils.ts"]) {
      fs.copyFileSync(path.join(import.meta.dir, file), path.join(root, "scripts", file))
    }
    // `contract.ts` derives the emitted renderer document from the product mode
    // rather than naming `index.html`, so it imports the module that owns that
    // mapping. Intra-package, which is what this fixture permits — the boundary
    // it asserts below is no reach into a SIBLING package (`../../claxedo-*`).
    // Copying the real file rather than stubbing it keeps the fixture honest:
    // if that module grows an Electron import, this test is where it surfaces.
    fs.mkdirSync(path.join(root, "src", "main"), { recursive: true })
    fs.copyFileSync(
      path.join(import.meta.dir, "..", "src", "main", "navigation-guard.ts"),
      path.join(root, "src", "main", "navigation-guard.ts"),
    )

    const proc = Bun.spawn({
      cmd: ["bun", path.join(root, "scripts", "build.ts")],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(code).not.toBe(0)
    expect(stderr).toContain(path.join("resources", "claxedo-server", "index.js"))
    expect(stderr).toContain("prebuild")
    // It stopped BEFORE electron-vite: no output tree, nothing started.
    expect(fs.existsSync(path.join(root, "out"))).toBe(false)
    expect(fs.existsSync(path.join(root, "dist"))).toBe(false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test("the bundle artifact path is the one Electron main launches", () => {
  // Main computes `out/main/claxedo-server/index.js` when packaged and
  // `resources/claxedo-server/index.js` in development; the contract's `match`
  // pair holds those two byte-identical. This is the development one, and it
  // is what predev writes and the boot smoke reads.
  expect(localServerBundleEntry(PACKAGE_DIR)).toBe(
    path.join(PACKAGE_DIR, "resources", "claxedo-server", "index.js"),
  )

  const main = fs.readFileSync(path.join(PACKAGE_DIR, "src/main/index.ts"), "utf8")
  expect(main).toContain(`"../../resources/claxedo-server/index.js"`)
})
