import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { importSpecifiers } from "../packages/claxedo-server-core/src/platform/governance/source-closure.ts"

const ROOT = path.resolve(import.meta.dirname, "..")

const PLUGINS = [
  { name: "@claxedo/tasks", dir: "packages/claxedo-tasks" },
  { name: "@claxedo/documents", dir: "packages/claxedo-documents" },
] as const

/**
 * What a first-party plugin may import. A plugin reaches a host only through
 * these contracts, so no plugin can depend on a server, the app or a CLI.
 * `@claxedo/workspace-runtime/host` is the runtime's `runGit`, which the local
 * Documents repository backend runs its git through.
 */
const PLUGIN_MAY_IMPORT = [
  "@claxedo/plugin-api",
  "@claxedo/server-core",
  "@claxedo/session-core",
  "@claxedo/workspace-runtime/route-contribution",
  "@claxedo/workspace-runtime/host",
  "@claxedo/mcp/tool-group",
  "@claxedo/account-contract/operation-definition",
  "@claxedo/helpers",
  "@claxedo/agent-runtime-contract",
] as const

/**
 * The production modules outside the plugins that import one: composition
 * roots, and the host adapters that implement a plugin's ports. No core
 * package (server-core, session-core, workspace-runtime, mcp, account-contract,
 * agent-runtime-contract, plugin-api, helpers) is here, and the app has only
 * its bundle list and its operation table.
 */
const PLUGIN_IMPORTERS = [
  "packages/claxedo-app/src/plugins/first-party/bundles.ts",
  "packages/claxedo-app/src/server/operations.ts",
  "packages/claxedo-desktop/src/main/account/hosted-operations.ts",
  "packages/claxedo-desktop/src/server/entry.ts",
  "packages/claxedo-host-serving/src/runtime.ts",
  "packages/claxedo-server/scripts/control-plane-schema.ts",
  "packages/claxedo-server/src/authority/adapters/d1/document-authority.ts",
  "packages/claxedo-server/src/deployments/hosted-workerd/core-worker.cf.ts",
  "packages/claxedo-server/src/deployments/hosted-workerd/tasks-plugin/cloud-roots.ts",
  "packages/claxedo-server/src/deployments/hosted-workerd/tasks-plugin/compose.ts",
  "packages/claxedo-server/src/documents/compose.ts",
  "packages/claxedo-server/src/documents/runtime-broker.ts",
  "packages/claxedo-server/src/hosts/workspace-runtime/host-entry.agent-plugins.ts",
  "packages/claxedo-server/src/hosts/workspace-runtime/host-entry.ts",
  "packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts",
  "packages/claxedo-server/src/session/owner-grant.ts",
  "packages/claxedo-server/src/session/session-rows-pass.ts",
  "packages/cli/src/plugin-commands.ts",
]

const SOURCE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/
const TEST_ONLY = /(?:^|\/)(?:test-support|e2e|fixtures)\/|(?:^|\/)testing\.ts$|\.(?:test|spec|test-d|typecheck|node-test)\.[cm]?[jt]sx?$|\.d\.ts$/

function productionSources(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "packages"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((file) => SOURCE.test(file) && !TEST_ONLY.test(file) && fs.existsSync(path.join(ROOT, file)))
}

function pluginOf(file: string) {
  return PLUGINS.find((plugin) => file.startsWith(`${plugin.dir}/`))
}

function namesPlugin(specifier: string): boolean {
  return PLUGINS.some((plugin) => specifier === plugin.name || specifier.startsWith(`${plugin.name}/`))
}

function relativeTarget(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  return path.relative(ROOT, path.resolve(ROOT, path.dirname(file), specifier)).split(path.sep).join("/")
}

function importsOf(file: string): string[] {
  return importSpecifiers(fs.readFileSync(path.join(ROOT, file), "utf8"))
}

function allowedForPlugin(specifier: string): boolean {
  return PLUGIN_MAY_IMPORT.some((allowed) => specifier === allowed || specifier.startsWith(`${allowed}/`))
}

const sources = productionSources()

test("only the composition roots and host adapters import a first-party plugin", () => {
  const importers = sources.filter((file) => {
    if (pluginOf(file)) return false
    return importsOf(file).some((specifier) => {
      const target = relativeTarget(file, specifier)
      return target === undefined ? namesPlugin(specifier) : pluginOf(target) !== undefined
    })
  })
  expect(importers.sort()).toEqual([...PLUGIN_IMPORTERS].sort())
})

test("a first-party plugin imports only the host contracts and stays inside its own package", () => {
  const plugins = sources.filter((file) => pluginOf(file))
  expect(plugins.length).toBeGreaterThan(100)
  const refused = plugins.flatMap((file) => {
    const own = pluginOf(file)
    return importsOf(file).flatMap((specifier) => {
      const target = relativeTarget(file, specifier)
      if (target !== undefined) return pluginOf(target) === own ? [] : [`${file} -> ${specifier}`]
      if (!specifier.startsWith("@claxedo/") || allowedForPlugin(specifier)) return []
      return [`${file} -> ${specifier}`]
    })
  })
  expect(refused).toEqual([])
})
