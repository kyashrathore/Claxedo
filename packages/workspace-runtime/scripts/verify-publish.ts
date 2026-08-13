#!/usr/bin/env tsx

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

const root = path.resolve(import.meta.dirname, "..")
const repoRoot = path.resolve(root, "..", "..")
const failures: string[] = []

const pkg = readJson(path.join(root, "package.json")) as {
  name: string
  version: string
  bin?: Record<string, string>
  exports: Record<string, Record<string, string>>
  files?: string[]
  repository?: { url?: string }
  homepage?: string
  bugs?: string | { url?: string }
}
const manifest = readJson(path.join(root, "docs", "api-manifest.json")) as {
  packageExports: string[]
  rootRuntimeExports: string[]
  routePrefixes: string[]
}

const rootApi = await import(pathToFileURL(path.join(root, "dist", "index.mjs")).href) as
  Record<string, unknown>
const routeApi = await import(pathToFileURL(path.join(root, "dist", "routes.mjs")).href) as {
  WorkspaceRuntimeRouteManifest: Array<{ path: string }>
  WorkspaceRuntimeRoutes: Record<string, string>
}

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

if (pkg.bin?.["workspace-runtime"] !== "./dist/cli.mjs") {
  failures.push("package.json must expose workspace-runtime at ./dist/cli.mjs")
} else {
  const cli = path.join(root, pkg.bin["workspace-runtime"])
  if (!fs.existsSync(cli)) {
    failures.push("workspace-runtime bin points at a missing file")
  } else {
    const major = Number(process.versions.node.split(".")[0])
    if (major < 22) failures.push(`workspace-runtime publish verification requires Node.js 22+, got ${process.version}`)
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
    + `${missing.length ? `; missing: ${missing.join(", ")}` : ""}`
    + `${extra.length ? `; extra: ${extra.join(", ")}` : ""}`,
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
