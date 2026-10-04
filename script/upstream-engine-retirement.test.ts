import { expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const retired = [
  "core",
  "schema",
  "llm",
  "plugin",
  "sdk",
  "http-recorder",
  "effect-drizzle-sqlite",
  "effect-sqlite-node",
  "server",
  "protocol",
  "tui",
  "codemode",
]

test("the workspace contains one published SDK engine and no vendored engine packages", () => {
  for (const name of retired) expect(existsSync(path.join(root, "packages", name, "package.json"))).toBe(false)
  expect(existsSync(path.join(root, "packages/sdk/js/package.json"))).toBe(false)
  const manifests = [
    "package.json",
    ...readdirSync(path.join(root, "packages")).map((name) => `packages/${name}/package.json`),
  ]
  for (const file of manifests) {
    if (!existsSync(path.join(root, file))) continue
    const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"))
    for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(manifest[section] ?? {})) {
        if (retired.some((item) => name === `@opencode-ai/${item}`))
          expect(String(version).startsWith("workspace:")).toBe(false)
      }
    }
  }
  const runtime = JSON.parse(readFileSync(path.join(root, "packages/workspace-runtime/package.json"), "utf8"))
  expect(runtime.dependencies["@opencode-ai/schema"]).toBe(runtime.dependencies["@opencode-ai/sdk"])
  expect(runtime.dependencies["@opencode-ai/plugin"]).toBe(runtime.dependencies["@opencode-ai/sdk"])
})
