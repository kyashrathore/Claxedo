import * as fs from "node:fs"
import * as path from "node:path"
import { $ } from "bun"
import { jsonRecord } from "@claxedo/helpers"

/**
 * The sibling packages the server bundle consumes through their published
 * `dist` rather than their source (see `script/published-exports-plugin.ts`):
 * every `@claxedo/*` workspace package that is not private and has a build.
 */
export function publishedPackageNames(repoRoot: string): string[] {
  return publishedPackages(repoRoot).map((entry) => entry.name)
}

/** The `dist` directory of every published sibling package, for staleness checks on what consumes them. */
export function publishedPackageDistDirs(repoRoot: string): string[] {
  return publishedPackages(repoRoot).map((entry) => path.join(entry.dir, "dist"))
}

function publishedPackages(repoRoot: string): { name: string; dir: string }[] {
  const packagesDir = path.join(repoRoot, "packages")
  const entries: { name: string; dir: string }[] = []
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(packagesDir, entry.name, "package.json")
    if (!fs.existsSync(manifestPath)) continue
    const record = jsonRecord(fs.readFileSync(manifestPath, "utf8"))
    if (!record) continue
    const name = record.name
    const scripts = record.scripts
    if (typeof name !== "string" || !name.startsWith("@claxedo/")) continue
    if (record.private === true) continue
    if (typeof scripts !== "object" || scripts === null || !("build" in scripts)) continue
    entries.push({ name, dir: path.join(packagesDir, entry.name) })
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export async function buildPublishedPackages(repoRoot: string, log: (message: string) => void) {
  const names = publishedPackageNames(repoRoot)
  log(`Building ${names.length} published package(s) the server bundle consumes from dist...`)
  await $`bun turbo build ${names.flatMap((name) => ["--filter", name])}`.cwd(repoRoot)
}
