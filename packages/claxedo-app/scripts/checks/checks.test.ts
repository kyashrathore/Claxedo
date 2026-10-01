import { spawnSync } from "node:child_process"
import { afterEach, expect, test } from "bun:test"
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { moduleStateExceptions } from "./data/module-state-exceptions"
import { packageRoot } from "./lib/files"
import * as hygiene from "./e2e-hygiene"
import * as ownership from "./one-home-per-datum"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(files: Readonly<Record<string, string>>): string[] {
  const root = mkdtempSync(join(tmpdir(), "app-check-proof-"))
  roots.push(root)
  return Object.entries(files).map(([path, text]) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return file
  })
}

function hooks(text: string, path = "src/view.ts") {
  const [file] = fixture({ [path]: text })
  return hygiene.testHooks(file!)
}

test("production hooks reject probes and E2E switches, preserving plugin protocols and test files", () => {
  expect(hooks('export const probe = "__claxedoTestState"')).toHaveLength(1)
  expect(hooks("export const enabled = import.meta.env.CLAXEDO_E2E_ENABLED")).toHaveLength(1)
  expect(hooks('export const protocol = "__claxedoPluginFrame"; export const name = "__claxedoPluginRuntime"')).toEqual([])
  expect(hooks('export const probe = "__claxedoTestState"', "src/view.test.ts")).toEqual([])
  expect(hooks('export const component = "SessionRow"')).toEqual([])
})

function states(text: string): string[] {
  const [file] = fixture({ "src/model.ts": text })
  return ownership.moduleStates([file!], {}).map((state) => state.binding)
}

for (const [name, source, binding] of [
  ["array push", 'const rows: string[] = []; export function append() { rows.push("session") }', "rows"],
  ["property increment", "const state = { count: 0 }; export function step() { state.count++ }", "state"],
  ["property assignment", "const state = { count: 0 }; export function step() { state.count = 2 }", "state"],
  ["property delete", "const state: { count?: number } = { count: 0 }; export function step() { delete state.count }", "state"],
] as const) {
  test(`module writes: ${name} needs a provider owner`, () => expect(states(source)).toEqual([binding]))
}

test("immutable lookup tables and shadowed parameters do not create module state", () => {
  expect(states('const labels = ["session"]; export const label = labels[0]')).toEqual([])
  expect(states("const state = { count: 0 }; export function step(state: { count: number }) { state.count++ }")).toEqual([])
})

test("ownership follows exported bindings and aliases without matching unrelated names", () => {
  const files = fixture({
    "src/a.ts": "export const rows: string[] = []",
    "src/b.ts": 'import { rows as items } from "./a"; items.push("session")',
    "src/c.ts": "export const rows = new Set([1])",
  })
  const results = ownership.moduleStates(files, {})
  expect(results.map((state) => state.file)).toEqual([files[0]])
})

function cli(check: string, files: Readonly<Record<string, string>>) {
  fixture(files)
  const root = roots.at(-1)!
  mkdirSync(join(root, "scripts/checks"), { recursive: true })
  cpSync(join(import.meta.dir, `${check}.ts`), join(root, `scripts/checks/${check}.ts`))
  for (const directory of ["lib", "data"]) cpSync(join(import.meta.dir, directory), join(root, `scripts/checks/${directory}`), { recursive: true })
  cpSync(join(packageRoot, "tsconfig.json"), join(root, "tsconfig.json"))
  symlinkSync(join(packageRoot, "node_modules"), join(root, "node_modules"))
  const result = spawnSync("bun", [join(root, `scripts/checks/${check}.ts`)], { cwd: root, encoding: "utf8" })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}

test("e2e CLI fails a production hook and passes clean source", () => {
  const steered = { "e2e/flows/38-session-sources.spec.ts": 'import { test } from "@playwright/test"; test("source failure", async ({ page }) => { await page.route("**/sessions", route => route.abort()) })' }
  const bad = cli("e2e-hygiene", { ...steered, "src/view.ts": 'export const probe = "__claxedoTestState"' })
  expect(bad.code).toBe(1)
  expect(bad.output).toContain("src/view.ts:1 e2e-hygiene test-only hook")
  expect(cli("e2e-hygiene", { ...steered, "src/view.ts": "export const component = 'SessionRow'" }).code).toBe(0)
})

test("ownership does not mistake reducer methods or test cleanup registries for production state", () => {
  const reducers = 'const reducers = { contents: { set: (value: number) => value } }; export function apply() { return reducers.contents.set(1) }'
  expect(states(reducers)).toEqual([])
  const files = fixture({ "src/cleanup.test.ts": 'const running = []; afterEach(() => running.pop())' })
  expect(ownership.moduleStates(files, {})).toEqual([])
})

function exceptionFixtures(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const { file, binding } of moduleStateExceptions) files[file] = (files[file] ?? "") + `let ${binding}: unknown\n`
  return files
}

test("ownership CLI rejects writes to a module array and accepts a constant lookup table", () => {
  const files = { ...exceptionFixtures(), "src/model.ts": 'const rows: string[] = []; export function append() { rows.push("session") }' }
  const bad = cli("one-home-per-datum", files)
  expect(bad.code).toBe(1)
  expect(bad.output).toContain("src/model.ts:1 one-home-per-datum module-level rows is mutated")
  expect(cli("one-home-per-datum", { ...files, "src/model.ts": 'const rows = ["session"]; export const first = rows[0]' }).code).toBe(0)
})

test("ownership resolves the app's path aliases to the authoritative module", () => {
  const files = fixture({
    "src/a.ts": "export const rows: string[] = []",
    "src/b.ts": 'import { rows as items } from "@/a"; items.push("session")',
  })
  const options = { paths: { "@/*": [join(roots.at(-1)!, "src/*")] } }
  expect(ownership.moduleStates(files, options).map((state) => state.file)).toEqual([files[0]])
})

test("a same-named local collection cannot mutate an unrelated exported binding", () => {
  const files = fixture({
    "src/a.ts": "export const rows = new Set([1])",
    "src/b.ts": "export function collect() { const rows = new Set(); rows.add(2) }",
  })
  expect(ownership.moduleStates(files, {})).toEqual([])
})
