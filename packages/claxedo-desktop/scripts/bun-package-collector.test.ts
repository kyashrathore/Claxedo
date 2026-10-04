import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

const builderRequire = createRequire(import.meta.resolve("electron-builder/package.json"))
const { BunNodeModulesCollector } = builderRequire("app-builder-lib/out/node-module-collector/bunNodeModulesCollector")
const { TmpDir } = builderRequire("temp-file")
const temporary: string[] = []

function write(directory: string, value: unknown) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, "package.json"), JSON.stringify(value))
}

function link(target: string, directory: string) {
  mkdirSync(path.dirname(directory), { recursive: true })
  symlinkSync(target, directory, process.platform === "win32" ? "junction" : "dir")
}

function fixture(options: { override?: string; installed?: string; missing?: boolean }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "claxedo-bun-collector-"))
  temporary.push(root)
  write(root, {
    name: "fixture",
    workspaces: { packages: ["packages/*"], catalog: { "@opentui/core": "0.3.4" } },
    overrides: options.override ? { "@opentui/core": options.override } : {},
  })
  writeFileSync(path.join(root, "bun.lock"), "{}")
  const app = path.join(root, "packages/desktop")
  write(app, {
    name: "fixture-desktop", version: "1.0.0",
    dependencies: { "@opencode-ai/simulation": "1.0.0" },
    // Bun ignores workspace-local overrides; only the root rule is authoritative.
    overrides: { "@opentui/core": "0.5.9" },
  })
  const simulationModules = path.join(root, "node_modules/.bun/simulation/node_modules")
  const simulation = path.join(simulationModules, "@opencode-ai/simulation")
  write(simulation, { name: "@opencode-ai/simulation", version: "1.0.0", dependencies: { "@opentui/core": "0.5.9" } })
  link(simulation, path.join(app, "node_modules/@opencode-ai/simulation"))
  if (!options.missing) {
    const core = path.join(root, "node_modules/.bun/core/node_modules/@opentui/core")
    write(core, { name: "@opentui/core", version: options.installed ?? "0.3.4" })
    link(core, path.join(simulationModules, "@opentui/core"))
  }
  return app
}

async function collect(app: string) {
  const tempDirManager = new TmpDir()
  try {
    const collector = new BunNodeModulesCollector(app, tempDirManager)
    return await collector.getNodeModules({ packageName: "fixture-desktop" })
  } finally {
    await tempDirManager.cleanup()
  }
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

for (const override of ["0.3.4", "catalog:"]) {
  test(`packages the installed Bun root override ${override} through the real collector`, async () => {
    const result = await collect(fixture({ override }))
    expect(result.nodeModules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "@opentui/core", version: "0.3.4" }),
      expect.objectContaining({ name: "@opencode-ai/simulation", version: "1.0.0" }),
    ]))
  })
}

test("still rejects an unoverridden dependency with the wrong installed version", async () => {
  await expect(collect(fixture({}))).rejects.toThrow("Production dependency @opentui/core not found")
})

test("still rejects an installed version that disagrees with the root catalog", async () => {
  await expect(collect(fixture({ override: "catalog:", installed: "0.5.9" }))).rejects.toThrow("Production dependency @opentui/core not found")
})

test("still rejects a missing production dependency when an override exists", async () => {
  await expect(collect(fixture({ override: "catalog:", missing: true }))).rejects.toThrow("Production dependency @opentui/core not found")
})

test("the builder config admits top-level natives without copying SDK-private native dependencies into asar", async () => {
  const { default: config } = await import("../electron-builder.config")
  const { FileMatcher } = builderRequire("app-builder-lib/out/fileMatcher")
  const app = fixture({ override: "catalog:" })
  const patterns = config.files!.filter((entry): entry is string => typeof entry === "string")
  const matcher = new FileMatcher(app, path.join(app, "output"), (pattern: string) => pattern, patterns)
  const filter = matcher.createFilter()
  const file = path.join(app, "package.json")
  const accepted = (moduleFullFilePath: string) => filter(file, Object.assign(statSync(file), { moduleFullFilePath }))

  expect(accepted("node_modules/@lydell/node-pty/index.js")).toBe(true)
  expect(accepted("node_modules/better-sqlite3/lib/index.js")).toBe(true)
  expect(accepted("node_modules/@opencode-ai/core/node_modules/@lydell/node-pty/index.js")).toBe(false)
  expect(accepted("node_modules/@opencode-ai/core/node_modules/better-sqlite3/prebuilds/darwin-arm64.node")).toBe(false)
  expect(accepted("node_modules/@opencode-ai/core/dist/index.js")).toBe(false)
})
