import { describe, expect, test } from "bun:test"
import path from "node:path"
const forbiddenPackages = [
  "claxedo-server",
  "control-plane",
  "workspace-store",
  "credentials",
]

function isForbiddenSpecifier(input: string) {
  return forbiddenPackages.some((name) => input.includes(name))
}

describe("workspace relay composition boundary", () => {
  test("package manifest does not depend on control-plane or store implementations", async () => {
    const manifest = await Bun.file(path.join(import.meta.dirname, "..", "package.json")).json() as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const dependencyNames = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]

    expect(dependencyNames.filter(isForbiddenSpecifier)).toEqual([])
  })

  test("relay dependency graph does not import control-plane or store implementations", async () => {
    const files = [
      "auth.ts",
      "cloudflare.ts",
      "directory.ts",
      "server.ts",
    ].map((file) => path.join(import.meta.dirname, file))
    const transpiler = new Bun.Transpiler({ loader: "ts" })

    for (const file of files) {
      const imports = transpiler.scanImports(await Bun.file(file).text())
      expect(imports.map((entry) => entry.path).filter(isForbiddenSpecifier)).toEqual([])
    }
  })

})
