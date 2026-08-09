import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { materializeIsolatedWorkspace, verifyIsolatedWorkspace, type IsolatedCommand } from "./isolated-workspace"
import type { Policy } from "./policy"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fakeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-isolation-fixture-"))
  roots.push(root)
  for (const file of ["bun.lock", "bunfig.toml", "tsconfig.json", "turbo.json"]) fs.writeFileSync(path.join(root, file), "fixture")
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }))
  for (const [name, exports] of [["allowed", true], ["excluded", true]] as const) {
    const dir = path.join(root, "packages", name)
    fs.mkdirSync(path.join(dir, "src"), { recursive: true })
    fs.writeFileSync(path.join(dir, "src/index.ts"), `export const name = "${name}"\n`)
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: `@fixture/${name}`,
      version: "1.0.0",
      exports: exports ? { ".": "./src/index.ts" } : undefined,
      scripts: { build: "bun src/index.ts" },
      dependencies: { hono: "1.0.0" },
    }))
  }
  return root
}

function policy(): Policy {
  return {
    id: "fixture",
    summary: "fixture",
    packageDir: "packages/allowed",
    entry: "packages/allowed/src/index.ts",
    roots: ["packages/allowed/src"],
    forbiddenPackages: [],
    forbiddenModules: [],
    control: { minModules: 1, requiredModules: [] },
    isolation: { packageDirs: ["packages/allowed"], commands: [["bun", "run", "build"]] },
  }
}

describe("isolated workspace", () => {
  test("copies allowlisted sources and makes every excluded workspace a source-less stub", () => {
    const root = fakeRepository()
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-isolation-output-"))
    roots.push(destination)

    materializeIsolatedWorkspace(policy(), destination, root)

    expect(fs.existsSync(path.join(destination, "packages/allowed/src/index.ts"))).toBe(true)
    expect(fs.existsSync(path.join(destination, "packages/excluded/src"))).toBe(false)
    const stub = JSON.parse(fs.readFileSync(path.join(destination, "packages/excluded/package.json"), "utf8"))
    expect(stub.exports).toBeUndefined()
    expect(stub.scripts).toBeUndefined()
    expect(stub.dependencies).toEqual({ hono: "1.0.0" })
  })

  test("runs frozen install before package commands and always removes the workspace", () => {
    const root = fakeRepository()
    const seen: IsolatedCommand[] = []
    let temporary = ""
    const ok = verifyIsolatedWorkspace(policy(), (input) => {
      seen.push(input)
      temporary = input.cwd.includes("packages/allowed") ? path.resolve(input.cwd, "../..") : input.cwd
      return 0
    }, root)

    expect(ok).toBe(true)
    expect(seen.map((item) => item.command)).toEqual([
      ["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--minimum-release-age=0"],
      ["bun", "run", "build"],
    ])
    expect(fs.existsSync(temporary)).toBe(false)
  })

  test("stops after a failure and still removes the workspace", () => {
    const root = fakeRepository()
    const seen: IsolatedCommand[] = []
    let temporary = ""
    const ok = verifyIsolatedWorkspace(policy(), (input) => {
      seen.push(input)
      temporary = input.cwd
      return 9
    }, root)

    expect(ok).toBe(false)
    expect(seen).toHaveLength(1)
    expect(fs.existsSync(temporary)).toBe(false)
  })
})
