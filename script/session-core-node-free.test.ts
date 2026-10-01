import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"
import { walk } from "./product-boundary/closure"

const core = path.resolve(import.meta.dirname, "../packages/session-core/src")
const NODE_BUILTIN = new Set(builtinModules.flatMap((name) => [name, name.split("/")[0]]))
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g
const PROCESS_ENV = /\bprocess\s*(?:\.\s*env\b|\[\s*["']env["']\s*\])/
const HOST_GLOBAL = /\bglobalThis\s*[.\[]|\bBuffer\s*[.(]|\bprocess\s*\.\s*(?:env|argv|cwd|platform|arch|stderr|stdout|versions|exit|pid)\b/

function violations(file: string): string[] {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
  const found = [...source.matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("node:") || NODE_BUILTIN.has(specifier))
    .map((specifier) => `imports ${specifier}`)
  if (PROCESS_ENV.test(source)) found.push("reads process.env")
  if (HOST_GLOBAL.test(source.replace(/globalThis\.(?:fetch|crypto)\b/g, "webApi"))) found.push("uses a host global")
  return found.map((what) => `${path.relative(core, file)} ${what}`)
}

test("every production file in session-core is Node-free", () => {
  const files = readdirSync(core, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !/\.(?:test|spec|typecheck)\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
    .map((name) => path.join(core, name))
  expect(files.length).toBeGreaterThan(70)
  expect(files.flatMap(violations)).toEqual([])
})

test("the public entry's transitive first-party closure is Node-free", () => {
  const followed = [
    ["@claxedo/harness", "packages/harness"],
    ["@claxedo/helpers", "packages/claxedo-helpers"],
    ["@claxedo/agent-runtime-contract", "packages/agent-runtime-contract"],
    ["@claxedo/workspace-relay-protocol", "packages/workspace-relay-protocol"],
  ].map(([name, dir]) => ({ name, dir }))
  const closure = walk({ entry: path.join(core, "index.ts"), roots: ["packages/session-core", ...followed.map((pkg) => pkg.dir)], followed, runtimeOnly: true })
  expect(closure.unresolved).toEqual([])
  expect(closure.outsideRoots).toEqual([])
  expect(closure.opaque).toEqual([])
  expect(closure.modules.flatMap((module) => violations(module.file))).toEqual([])
})

test("the scan catches every import shape it guards against", () => {
  const shapes = [
    `import fs from "fs"`, `import { randomUUID } from "node:crypto"`, `export { join } from "path"`,
    `const os = await import("os")`, `const cp = require("child_process")`, `import "node:worker_threads"`,
    `import { readFile } from "fs/promises"`,
  ]
  const flagged = (source: string) => [...source.matchAll(SPECIFIER)].some((match) => match[1].startsWith("node:") || NODE_BUILTIN.has(match[1]))
  expect(shapes.filter((shape) => !flagged(shape))).toEqual([])
  expect(PROCESS_ENV.test("const home = process.env.HOME")).toBe(true)
  expect(PROCESS_ENV.test(`process["env"]`)).toBe(true)
  expect(HOST_GLOBAL.test("globalThis[Symbol.for('bus')]")).toBe(true)
  expect(HOST_GLOBAL.test("Buffer.alloc(10)")).toBe(true)
  expect([...`import { x } from "./session"`.matchAll(SPECIFIER)].map((match) => match[1])).toEqual(["./session"])
})
