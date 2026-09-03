import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import * as rootApi from "./index"
import * as harnessApi from "./harnesses"
import * as memoryApi from "./stores/memory"
import * as sqliteApi from "./stores/sqlite"
import * as virtualSessionEnvApi from "./virtual-session-env"

const root = path.resolve(import.meta.dirname, "..")
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  name: string
  version: string
  exports: Record<string, Record<string, string>>
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs/api-manifest.json"), "utf8")) as {
  package: string
  version: string
  entrypoints: Record<string, unknown>
  valueExports: Record<string, string[]>
  declarationHashes: Record<string, string>
  symbols: Record<string, { import: string; kind: string; purpose: string }>
}
const modules: Record<string, Record<string, unknown>> = {
  [pkg.name]: rootApi,
  [`${pkg.name}/harnesses`]: harnessApi,
  [`${pkg.name}/stores/memory`]: memoryApi,
  [`${pkg.name}/stores/sqlite`]: sqliteApi,
  [`${pkg.name}/virtual-session-env`]: virtualSessionEnvApi,
}

describe("agent-sdk-runtime public API manifest", () => {
  test("package identity, version, and entrypoints exactly match package.json", () => {
    expect(manifest.package).toBe(pkg.name)
    expect(manifest.version).toBe(pkg.version)
    const exported = Object.keys(pkg.exports).map((key) => key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`).sort()
    expect(Object.keys(manifest.entrypoints).sort()).toEqual(exported)
    expect(Object.keys(manifest.declarationHashes).sort()).toEqual(exported)
  })

  test("reviewed value exports exactly match their source entrypoints", () => {
    for (const [entrypoint, expected] of Object.entries(manifest.valueExports)) {
      expect(Object.keys(modules[entrypoint] ?? {}).sort(), entrypoint).toEqual([...expected].sort())
    }
  })

  test("documented value symbols exist at their declared entrypoint", () => {
    for (const [name, symbol] of Object.entries(manifest.symbols)) {
      if (symbol.kind === "type") continue
      expect(modules[symbol.import]?.[name], `${name} from ${symbol.import}`).toBeDefined()
    }
  })

  test("factory documentation matches actual access boundaries", () => {
    const factories = {
      claude: harnessApi.claude(),
      codex: harnessApi.codex(),
      cursor: harnessApi.cursor(),
      opencode: harnessApi.opencode(),
      pi: harnessApi.pi(),
      acp: harnessApi.acp("operator-agent", { binary: "operator-agent" }),
    } as Record<string, unknown>
    for (const [name, factory] of Object.entries(factories)) {
      const access = (factory as { access: string }).access
      expect(access, name).toBe(name === "acp" ? "acp" : "native")
      expect(manifest.symbols[name]?.purpose).not.toContain("native or ACP")
    }
  })
})
