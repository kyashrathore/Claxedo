import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import path from "node:path"

const runtime = path.resolve(import.meta.dirname, "../packages/workspace-runtime/src")

/**
 * The session core has to run in a Durable Object as well as on a machine, so
 * nothing in it may reach for a Node builtin or the process environment; the
 * host supplies those through ports. The store and its SQLite port belong to
 * the core too, which the workerd store suite exercises end to end.
 */
const CORE = ["projection", "session", "broker-ports", "store.ts", "store-schema.ts", "sqlite/database.ts", "sqlite/durable-object.ts"]

const NODE_BUILTIN = new Set(builtinModules.flatMap((name) => [name, name.split("/")[0]]))

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g
const PROCESS_ENV = /\bprocess\s*(?:\.\s*env\b|\[\s*["']env["']\s*\])/

function productionFiles(entry: string): string[] {
  const absolute = path.join(runtime, entry)
  if (statSync(absolute).isFile()) return [absolute]
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
    .map((name) => path.join(absolute, name))
}

function violations(file: string): string[] {
  const text = readFileSync(file, "utf8")
  const found = [...text.matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith("node:") || NODE_BUILTIN.has(specifier))
    .map((specifier) => `imports ${specifier}`)
  if (PROCESS_ENV.test(text)) found.push("reads process.env")
  return found.map((what) => `${path.relative(runtime, file)} ${what}`)
}

test("the session core imports no Node builtin and reads no process environment", () => {
  const scanned = CORE.map((entry) => ({ entry, files: productionFiles(entry) }))
  expect(scanned.filter((item) => item.files.length === 0).map((item) => item.entry)).toEqual([])
  expect(scanned.flatMap((item) => item.files).flatMap(violations)).toEqual([])
})

test("the scan catches every import shape it guards against", () => {
  const shapes = [
    `import fs from "fs"`,
    `import { randomUUID } from "node:crypto"`,
    `export { join } from "path"`,
    `const os = await import("os")`,
    `const cp = require("child_process")`,
    `import "node:worker_threads"`,
    `import { readFile } from "fs/promises"`,
  ]
  const flagged = (source: string) =>
    [...source.matchAll(SPECIFIER)].some((match) => match[1].startsWith("node:") || NODE_BUILTIN.has(match[1]))
  expect(shapes.filter((shape) => !flagged(shape))).toEqual([])
  expect(PROCESS_ENV.test("const home = process.env.HOME")).toBe(true)
  expect(PROCESS_ENV.test(`process["env"]`)).toBe(true)
  expect([...`import { x } from "./session"`.matchAll(SPECIFIER)].map((match) => match[1])).toEqual(["./session"])
})
