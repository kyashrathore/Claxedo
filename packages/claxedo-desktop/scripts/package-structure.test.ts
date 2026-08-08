import { expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  ALL_NATIVE_MODULES,
  ASAR_STRUCTURAL_ROOTS,
  NATIVE_MODULES,
  WINDOWS_NATIVE_MODULES,
  asarStructuralGlobs,
  isDeclaredStructuralEntry,
} from "./package-structure"
import { verifyPackageContents } from "./verify-package-contents"

/**
 * The packaged app contains only declared structural resources.
 *
 * `electron-builder.config.ts` decides what goes in and
 * `verify-package-contents.ts` checks what came out. They used to spell the
 * native-module set twice, which made the check unable to disagree with the
 * config; both now read one declaration, and these tests hold the pair
 * together — including against a synthetic asar, so the invariant is exercised
 * without a signed, notarized release build.
 */

test("the electron-builder file globs are exactly the declared roots", () => {
  expect(asarStructuralGlobs()).toEqual(ASAR_STRUCTURAL_ROOTS.map((root) => `${root}/**/*`))

  // And the config admits nothing beyond them. Read as text on purpose: the
  // config's top level throws when the platform pty package is absent, so it
  // cannot be imported in a unit test — but a hand-written positive glob is
  // exactly the regression this catches, and it would be visible right here.
  //
  // Comments are dropped LINE-WISE, not by the usual block-comment regex: this
  // file is full of globs like `"!**/node_modules/**"`, and `/**` inside a
  // string opens a comment as far as that regex is concerned — it swallowed the
  // rest of the file and the assertion below passed on nothing.
  const config = fs.readFileSync(path.resolve(import.meta.dir, "../electron-builder.config.ts"), "utf8")
  const block = config.match(/\n {2}files: \[\n([\s\S]*?)\n {2}\],/)?.[1]

  expect(block).toBeString()
  const code = block!
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n")

  expect(code).toContain("asarStructuralGlobs()")
  // Every remaining literal is either an exclusion or a native-module path —
  // never a new structural root smuggled in beside the declared ones.
  const literals = [...code.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
  expect(literals.filter((glob) => !glob.startsWith("!") && !glob.includes("node_modules/"))).toEqual([])
})

test("the config's native-module list and the verifier's allowlist cannot drift", () => {
  // The config spells the base set by importing it, and the Windows one
  // inline — because `src/main/diagnostics/process-metrics-source.test.ts`
  // pins that exact source line as the audited-dependency record. Two
  // spellings therefore exist; this holds them equal, which is the property
  // the shared declaration was for.
  const config = fs.readFileSync(path.resolve(import.meta.dir, "../electron-builder.config.ts"), "utf8")
  const conditional = config.match(/win32-"\) \? \[([^\]]*)\] : \[\]/)?.[1]

  expect(conditional).toBeString()
  const inlineWindows = [...conditional!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)

  expect(inlineWindows).toEqual([...WINDOWS_NATIVE_MODULES])
  expect(config).toContain("BASE_NATIVE_MODULES")
  for (const module of [...NATIVE_MODULES, ...inlineWindows]) {
    expect(ALL_NATIVE_MODULES, module).toContain(module)
  }
})

test("only the declared roots count as structural", () => {
  expect(isDeclaredStructuralEntry("out/main/index.js")).toBe(true)
  expect(isDeclaredStructuralEntry("out/main/claxedo-server/index.js")).toBe(true)
  expect(isDeclaredStructuralEntry("resources/icons/icon.icns")).toBe(true)
  expect(isDeclaredStructuralEntry("package.json")).toBe(true)

  expect(isDeclaredStructuralEntry("resources/acp/codex-acp")).toBe(false)
  expect(isDeclaredStructuralEntry("src/main/index.ts")).toBe(false)
  // Prefix, not substring: a sibling directory whose name merely starts the
  // same way is not inside the declared root.
  expect(isDeclaredStructuralEntry("outside/secret.js")).toBe(false)
})

/** Write an asar whose header lists `files`, which is all the verifier reads. */
function fakeAsar(target: string, files: string[]) {
  const tree: Record<string, unknown> = {}
  for (const file of files) {
    let node = tree
    const parts = file.split("/")
    for (const part of parts.slice(0, -1)) {
      const next = (node[part] ??= { files: {} }) as { files: Record<string, unknown> }
      node = next.files
    }
    node[parts.at(-1)!] = { size: 1, offset: "0" }
  }
  const json = Buffer.from(JSON.stringify({ files: tree }))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(json.length + 8, 4)
  head.writeUInt32LE(json.length + 4, 8)
  head.writeUInt32LE(json.length, 12)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, Buffer.concat([head, json]))
}

function withAsar(files: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-asar-"))
  fakeAsar(path.join(root, "dist/mac/Claxedo.app/Contents/Resources/app.asar"), files)
  try {
    return verifyPackageContents(root).failures
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test("a package of declared output and native modules passes", () => {
  expect(
    withAsar([
      "package.json",
      "out/main/index.js",
      "out/main/claxedo-server/index.js",
      "out/renderer/index.html",
      "resources/icons/icon.icns",
      "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "node_modules/@lydell/node-pty/index.js",
    ]),
  ).toEqual([])
})

test("an undeclared structural directory fails, reported once by root", () => {
  const failures = withAsar([
    "package.json",
    "out/main/index.js",
    "resources/acp/codex-acp",
    "resources/acp/claude-agent-acp",
  ])

  expect(failures.length).toBe(1)
  expect(failures[0]).toContain("resources ships but is not a declared structural resource")
})

test("an undeclared node_modules package still fails", () => {
  const failures = withAsar(["package.json", "out/main/index.js", "node_modules/hono/dist/index.js"])

  expect(failures.length).toBe(1)
  expect(failures[0]).toContain("node_modules/hono")
})
