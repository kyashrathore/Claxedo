import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const repositoryRoot = path.resolve(serverRoot, "../..")
const sourceRoot = path.join(repositoryRoot, "convex")
const defaultOutputRoot = path.join(serverRoot, ".artifacts/agent-plugins-convex-profile")

function relative(source: string) {
  return path.relative(sourceRoot, source).replaceAll(path.sep, "/")
}

function copiedSource(source: string, enabled: boolean) {
  const entry = relative(source)
  if (!entry) return true
  if (entry.endsWith(".test.ts")) return false
  if (entry === "convex.config.ts" || entry === "agentPlugins.feature.ts") return false
  if (!enabled && (entry === "components/agentPlugins" || entry.startsWith("components/agentPlugins/"))) return false
  return true
}

function enabledConfig() {
  return `import { defineApp } from "convex/server"
import migrations from "@convex-dev/migrations/convex.config"
import agentPlugins from "./components/agentPlugins/convex.config"

const app = defineApp()
app.use(migrations)
app.use(agentPlugins, { name: "agentPlugins" })

export default app
`
}

function stringRecord(value: unknown): value is Record<string, string> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string")
}

function deploymentPackage() {
  const repositoryPackage: unknown = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  )
  if (!repositoryPackage
    || typeof repositoryPackage !== "object"
    || Array.isArray(repositoryPackage)
    || !("dependencies" in repositoryPackage)
    || !stringRecord(repositoryPackage.dependencies)) {
    throw new Error("Agent Plugins Convex profile requires string-valued root dependencies")
  }
  const dependencies = repositoryPackage.dependencies
  for (const name of ["convex", "@convex-dev/migrations"]) {
    if (!dependencies[name]) throw new Error(`Agent Plugins Convex profile requires root dependency ${name}`)
  }
  return {
    private: true,
    type: "module",
    dependencies,
  }
}

export function buildAgentPluginsConvexProfile(input: {
  enabled: boolean
  outputRoot?: string
}) {
  const outputRoot = path.resolve(input.outputRoot ?? defaultOutputRoot)
  const output = path.join(outputRoot, "convex")
  fs.rmSync(outputRoot, { recursive: true, force: true })
  fs.mkdirSync(outputRoot, { recursive: true })
  fs.cpSync(sourceRoot, output, {
    recursive: true,
    filter: (source) => copiedSource(source, input.enabled),
  })
  if (input.enabled) {
    fs.copyFileSync(path.join(sourceRoot, "agentPlugins.feature.ts"), path.join(output, "agentPlugins.ts"))
    fs.writeFileSync(path.join(output, "convex.config.ts"), enabledConfig())
  } else {
    fs.copyFileSync(path.join(sourceRoot, "convex.config.ts"), path.join(output, "convex.config.ts"))
  }
  // Convex resolves the functions directory from the nearest package root and
  // refuses to deploy a generated tree that does not declare its own Convex
  // dependency. Keep this profile directly runnable by deploy-hosted instead
  // of requiring operators to copy it over the repository root.
  fs.writeFileSync(
    path.join(outputRoot, "package.json"),
    `${JSON.stringify(deploymentPackage(), null, 2)}\n`,
  )
  const files = fs.readdirSync(output, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(output, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"))
    .sort()
  fs.writeFileSync(path.join(outputRoot, "profile.json"), `${JSON.stringify({ enabled: input.enabled, files }, null, 2)}\n`)
  return { outputRoot, convexRoot: output, files }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const enabled = process.argv.includes("--enabled")
  const disabled = process.argv.includes("--disabled")
  if (enabled === disabled) throw new Error("Choose exactly one of --enabled or --disabled")
  const result = buildAgentPluginsConvexProfile({ enabled })
  console.log(result.convexRoot)
}
