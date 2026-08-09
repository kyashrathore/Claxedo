import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import {
  materializeIsolatedWorkspace,
  verifyIsolatedWorkspace,
  workspaceDependencyClosure,
  type IsolatedCommand,
} from "./isolated-workspace"
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
  fs.mkdirSync(path.join(root, ".github"))
  fs.writeFileSync(path.join(root, ".github/BUILD_INPUT"), "fixture\n")
  for (const [name, dependency] of [["allowed", "@fixture/allowed-dependency"], ["allowed-dependency", undefined], ["excluded", undefined]] as const) {
    const dir = path.join(root, "packages", name)
    fs.mkdirSync(path.join(dir, "src"), { recursive: true })
    fs.writeFileSync(path.join(dir, "src/index.ts"), `export const name = "${name}"\n`)
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: `@fixture/${name}`,
      version: "1.0.0",
      exports: { ".": "./src/index.ts" },
      scripts: { build: "bun src/index.ts" },
      dependencies: { hono: "1.0.0", ...(dependency ? { [dependency]: "workspace:*" } : {}) },
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
    isolation: {
      additionalFiles: [".github/BUILD_INPUT"],
      buildPackages: [{ packageDir: "packages/allowed-dependency", environment: { FIXTURE_MODE: "isolated" } }],
      commands: [["bun", "run", "build"]],
    },
  }
}

describe("isolated workspace", () => {
  test("copies allowlisted sources and makes every excluded workspace a source-less stub", () => {
    const root = fakeRepository()
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-isolation-output-"))
    roots.push(destination)

    materializeIsolatedWorkspace(policy(), destination, root)

    expect(fs.existsSync(path.join(destination, "packages/allowed/src/index.ts"))).toBe(true)
    expect(fs.existsSync(path.join(destination, "packages/allowed-dependency/src/index.ts"))).toBe(true)
    expect(fs.existsSync(path.join(destination, "packages/excluded/src"))).toBe(false)
    expect(fs.readFileSync(path.join(destination, ".github/BUILD_INPUT"), "utf8")).toBe("fixture\n")
    const stub = JSON.parse(fs.readFileSync(path.join(destination, "packages/excluded/package.json"), "utf8"))
    expect(stub.exports).toBeUndefined()
    expect(stub.scripts).toBeUndefined()
    expect(stub.dependencies).toEqual({ hono: "1.0.0" })
  })

  test("derives the allowlist from transitive workspace dependencies", () => {
    const root = fakeRepository()
    expect(workspaceDependencyClosure("packages/allowed", root)).toEqual([
      "packages/allowed",
      "packages/allowed-dependency",
    ])
  })

  test("rejects an unused forbidden dependency declared by the product", () => {
    const root = fakeRepository()
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-isolation-output-"))
    roots.push(destination)
    const file = path.join(root, "packages/allowed/package.json")
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
    manifest.dependencies["@fixture/excluded"] = "workspace:*"
    fs.writeFileSync(file, JSON.stringify(manifest))
    const input = policy()
    input.forbiddenPackages = ["@fixture/excluded"]

    expect(() => materializeIsolatedWorkspace(input, destination, root)).toThrow(
      "forbidden manifest dependency: @fixture/excluded",
    )
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
      ["bun", "run", "build"],
    ])
    expect(seen[1]?.cwd).toContain("packages/allowed-dependency")
    expect(seen[1]?.environment).toEqual({ FIXTURE_MODE: "isolated" })
    expect(seen[2]?.cwd).toContain("packages/allowed")
    expect(fs.existsSync(temporary)).toBe(false)
  })

  test("rejects dependency builds outside the derived workspace closure", () => {
    const root = fakeRepository()
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-isolation-output-"))
    roots.push(destination)
    const input = policy()
    input.isolation!.buildPackages = [{ packageDir: "packages/excluded" }]

    expect(() => materializeIsolatedWorkspace(input, destination, root)).toThrow(
      "isolation build package is outside its workspace dependency closure",
    )
  })

  test("rejects additional files outside the repository", () => {
    const root = fakeRepository()
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-isolation-output-"))
    roots.push(destination)
    const input = policy()
    input.isolation!.additionalFiles = ["../outside"]

    expect(() => materializeIsolatedWorkspace(input, destination, root)).toThrow(
      "isolation file leaves the repository",
    )
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

  test("fails when the isolated build does not emit its declared manifest", () => {
    const root = fakeRepository()
    let temporary = ""
    const input = policy()
    input.emitted = {
      file: "packages/allowed/.artifacts/manifest.json",
      minModules: 1,
      minChunks: 1,
      requiredModules: ["packages/allowed/src/index.ts"],
    }
    const ok = verifyIsolatedWorkspace(input, (command) => {
      temporary = command.cwd.includes("packages/") ? path.resolve(command.cwd, "../..") : command.cwd
      return 0
    }, root)

    expect(ok).toBe(false)
    expect(fs.existsSync(temporary)).toBe(false)
  })
})
