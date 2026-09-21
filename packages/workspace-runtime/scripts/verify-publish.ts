#!/usr/bin/env tsx

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"
import { z } from "zod"

const root = path.resolve(import.meta.dirname, "..")
const repoRoot = path.resolve(root, "..", "..")
const failures: string[] = []

/**
 * The files this gate reads, PARSED rather than asserted.
 *
 * This script exists to catch a published package that no longer matches its
 * manifest, so a file whose shape has drifted is exactly the failure it is
 * looking for — asserting the shape made that the one drift it could not see.
 */
const PackageJson = z.object({
  name: z.string(),
  version: z.string(),
  bin: z.record(z.string(), z.string()).optional(),
  exports: z.record(z.string(), z.record(z.string(), z.string())),
  files: z.array(z.string()).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  repository: z.object({ url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  bugs: z.union([z.string(), z.object({ url: z.string().optional() })]).optional(),
})

const ApiManifest = z.object({
  packageExports: z.array(z.string()),
  rootRuntimeExports: z.array(z.string()),
  routePrefixes: z.array(z.string()),
})

const RouteApi = z.object({
  WorkspaceRuntimeRouteManifest: z.array(z.object({ path: z.string() })),
  WorkspaceRuntimeRoutes: z.record(z.string(), z.string()),
})

const PatchManifest = z.object({ claxedoDependencyPatches: z.record(z.string(), z.string()) })

const pkg = PackageJson.parse(readJson(path.join(root, "package.json")))
const manifest = ApiManifest.parse(readJson(path.join(root, "docs", "api-manifest.json")))

const rootApi: Record<string, unknown> = await import(pathToFileURL(path.join(root, "dist", "index.mjs")).href)
const routeApi = RouteApi.parse(await import(pathToFileURL(path.join(root, "dist", "routes.mjs")).href))

compareSet(
  "package.json exports vs docs/api-manifest.json packageExports",
  Object.keys(pkg.exports),
  manifest.packageExports,
)
compareSet(
  "dist root value exports vs docs/api-manifest.json rootRuntimeExports",
  Object.keys(rootApi),
  manifest.rootRuntimeExports,
)
compareSet(
  "dist route manifest vs docs/api-manifest.json routePrefixes",
  routeApi.WorkspaceRuntimeRouteManifest.map((item) => item.path),
  manifest.routePrefixes,
)
compareSet(
  "dist WorkspaceRuntimeRoutes values vs docs/api-manifest.json routePrefixes",
  Object.values(routeApi.WorkspaceRuntimeRoutes),
  manifest.routePrefixes,
)

for (const key of manifest.packageExports) {
  const entry = pkg.exports[key]
  if (!entry) continue
  for (const condition of ["types", "bun", "development", "import", "default"]) {
    if (!entry[condition]) {
      failures.push(`package export ${key} is missing the ${condition} condition`)
      continue
    }
    if (!fs.existsSync(path.join(root, entry[condition]))) {
      failures.push(`package export ${key}.${condition} points at missing file ${entry[condition]}`)
    }
  }
  if (entry.default !== entry.import) {
    failures.push(`package export ${key}.default must match ${key}.import`)
  }
}

if (!pkg.files?.includes("docs/api-manifest.json")) {
  failures.push("package.json files must include docs/api-manifest.json")
}

if (pkg.scripts?.postinstall !== "node scripts/install-opencode-node.mjs"
  || !pkg.files?.includes("scripts/install-opencode-node.mjs")) {
  failures.push("published package must run and include the Node SDK patch installer")
}
const patchRoot = path.join(root, "dist/opencode-node")
const patchManifest = PatchManifest.parse(readJson(path.join(patchRoot, "package.json")))
const rootPatches = PatchManifest.parse(readJson(path.join(repoRoot, "package.json"))).claxedoDependencyPatches
compareSet("published OpenCode patches vs canonical patches",
  Object.keys(patchManifest.claxedoDependencyPatches),
  Object.keys(rootPatches).filter((name) => name.startsWith("@opencode-ai/")))
for (const [name, file] of Object.entries(patchManifest.claxedoDependencyPatches)) {
  if (!fs.readFileSync(path.join(patchRoot, file)).equals(fs.readFileSync(path.join(repoRoot, rootPatches[name])))) {
    failures.push(`published patch differs from canonical patch: ${name}`)
  }
}
if (!fs.existsSync(path.join(patchRoot, "script/apply-dependency-patches.mjs"))) {
  failures.push("published Node SDK patch runner is missing")
}

if (pkg.bin?.["workspace-runtime"] !== "./dist/cli.mjs") {
  failures.push("package.json must expose workspace-runtime at ./dist/cli.mjs")
} else {
  const cli = path.join(root, pkg.bin["workspace-runtime"])
  if (!fs.existsSync(cli)) {
    failures.push("workspace-runtime bin points at a missing file")
  } else {
    const major = Number(process.versions.node.split(".")[0])
    if (major < 24) failures.push(`workspace-runtime publish verification requires Node.js 24+, got ${process.version}`)
    const version = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim()
    if (version !== pkg.version) failures.push(`workspace-runtime --version returned ${version}, expected ${pkg.version}`)
  }
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8")
for (const key of manifest.packageExports) {
  const importName = key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`
  if (!readme.includes(`\`${importName}\``)) {
    failures.push(`README.md public surface table is missing ${importName}`)
  }
}

compareSet(
  "README.md root runtime value exports vs docs/api-manifest.json rootRuntimeExports",
  codeTokens(section(readme, "Root runtime value exports:", "Relay host helpers")),
  manifest.rootRuntimeExports,
)
compareSet(
  "README.md route table vs docs/api-manifest.json routePrefixes",
  routePrefixes(section(readme, "## Routes", "## Event contract")),
  manifest.routePrefixes,
)

const publicDocsPath = path.join(repoRoot, "public-docs", "workspace-runtime.md")
if (fs.existsSync(publicDocsPath)) {
  compareSet(
    "public-docs/workspace-runtime.md route families vs docs/api-manifest.json routePrefixes",
    routePrefixes(section(fs.readFileSync(publicDocsPath, "utf8"), "## Mounted Route Families", "## Grounding")),
    manifest.routePrefixes,
  )
}

const npmFacingText = [
  JSON.stringify(pkg.repository ?? {}),
  pkg.homepage ?? "",
  typeof pkg.bugs === "string" ? pkg.bugs : pkg.bugs?.url ?? "",
  readme,
].join("\n")

if (npmFacingText.includes("github.com/anomalyco/opencode") || npmFacingText.includes("anomalyco/opencode")) {
  failures.push("npm-facing package metadata and README links must not point at anomalyco/opencode")
}

if (failures.length > 0) {
  console.error("Publish verification failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

execFileSync(process.execPath, [path.join(root, "scripts/acp-question-package-smoke.mjs")], {
  cwd: root,
  stdio: "inherit",
})

console.log("Publish verification passed")

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as unknown
}

function compareSet(label: string, actual: string[], expected: string[]) {
  const actualSorted = unique(actual).sort()
  const expectedSorted = unique(expected).sort()
  if (JSON.stringify(actualSorted) === JSON.stringify(expectedSorted)) return
  const missing = expectedSorted.filter((item) => !actualSorted.includes(item))
  const extra = actualSorted.filter((item) => !expectedSorted.includes(item))
  failures.push(
    `${label} mismatch`
    + (missing.length ? `; missing: ${missing.join(", ")}` : "")
    + (extra.length ? `; extra: ${extra.join(", ")}` : ""),
  )
}

function unique(input: string[]) {
  return [...new Set(input)]
}

function section(text: string, start: string, end: string) {
  const startIndex = text.indexOf(start)
  if (startIndex === -1) {
    failures.push(`Could not find section marker: ${start}`)
    return ""
  }
  const endIndex = text.indexOf(end, startIndex + start.length)
  if (endIndex === -1) {
    failures.push(`Could not find section marker after ${start}: ${end}`)
    return ""
  }
  return text.slice(startIndex + start.length, endIndex)
}

function codeTokens(text: string) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter((item): item is string => !!item)
}

function routePrefixes(text: string) {
  return unique(
    [...text.matchAll(/\/api\/wr(?:\/[A-Za-z0-9_:-]+)+(?:\/\*)?/g)]
      .map((match) => match[0]?.replace(/\/\*$/, ""))
      .filter((item): item is string => !!item),
  )
}
