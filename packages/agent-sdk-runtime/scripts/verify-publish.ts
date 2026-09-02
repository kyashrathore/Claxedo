#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"

const root = path.resolve(import.meta.dirname, "..")
const pkg = readJson(path.join(root, "package.json")) as {
  name: string
  version: string
  files?: string[]
  exports: Record<string, Record<string, string>>
}
const manifest = readJson(path.join(root, "docs/api-manifest.json")) as {
  package: string
  version: string
  entrypoints: Record<string, unknown>
  valueExports: Record<string, string[]>
  declarationHashes: Record<string, string>
}
const failures: string[] = []

if (manifest.package !== pkg.name) failures.push(`manifest package ${manifest.package} != ${pkg.name}`)
if (manifest.version !== pkg.version) failures.push(`manifest version ${manifest.version} != ${pkg.version}`)

const packageEntrypoints = Object.keys(pkg.exports).map((key) => key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`)
compareSet("package exports vs manifest entrypoints", packageEntrypoints, Object.keys(manifest.entrypoints))
compareSet("package exports vs declaration hash coverage", packageEntrypoints, Object.keys(manifest.declarationHashes))

for (const [key, conditions] of Object.entries(pkg.exports)) {
  for (const condition of ["types", "bun", "development", "import", "default"]) {
    const target = conditions[condition]
    if (!target) failures.push(`${key} is missing ${condition}`)
    else if (!fs.existsSync(path.join(root, target))) failures.push(`${key}.${condition} points at missing ${target}`)
  }
  if (conditions.default !== conditions.import) failures.push(`${key}.default must equal ${key}.import`)
}

const declarationHashes = Object.fromEntries(Object.entries(pkg.exports).map(([key, conditions]) => {
  const entrypoint = key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`
  return [entrypoint, declarationClosureHash(path.join(root, conditions.types))]
}))
if (process.argv.includes("--print-declaration-hashes")) {
  console.log(JSON.stringify(declarationHashes, null, 2))
  process.exit(0)
}
for (const [entrypoint, hash] of Object.entries(declarationHashes)) {
  if (manifest.declarationHashes[entrypoint] !== hash) {
    failures.push(`${entrypoint} declaration closure changed: ${manifest.declarationHashes[entrypoint] ?? "missing"} != ${hash}`)
  }
}

for (const [entrypoint, expected] of Object.entries(manifest.valueExports)) {
  const key = entrypoint === pkg.name ? "." : `.${entrypoint.slice(pkg.name.length)}`
  const target = pkg.exports[key]?.import
  if (!target) continue
  const module = await import(pathToFileURL(path.join(root, target)).href) as Record<string, unknown>
  compareSet(`${entrypoint} built value exports`, Object.keys(module), expected)
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8")
for (const entrypoint of Object.keys(manifest.entrypoints)) {
  if (!readme.includes(`\`${entrypoint}\``)) failures.push(`README public entrypoint table is missing ${entrypoint}`)
}
if (!pkg.files?.includes("docs")) failures.push("package files must include docs")

if (failures.length) {
  console.error("Publish verification failed:")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log("Publish verification passed")

function readJson(file: string) { return JSON.parse(fs.readFileSync(file, "utf8")) as unknown }
function compareSet(label: string, actual: string[], expected: string[]) {
  const left = [...new Set(actual)].sort()
  const right = [...new Set(expected)].sort()
  if (JSON.stringify(left) !== JSON.stringify(right)) failures.push(`${label}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`)
}

function declarationClosureHash(entryFile: string) {
  const queue = [entryFile]
  const seen = new Set<string>()
  const declarations: string[] = []
  while (queue.length) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const source = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim()
    declarations.push(`${path.relative(root, file)}\n${source}`)
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      const dependency = resolveDeclaration(path.dirname(file), match[1]!)
      if (dependency) queue.push(dependency)
    }
  }
  return createHash("sha256").update(declarations.sort().join("\n---\n")).digest("hex")
}

function resolveDeclaration(directory: string, specifier: string) {
  const stem = path.resolve(directory, specifier.replace(/\.js$/, ""))
  for (const candidate of [`${stem}.d.ts`, path.join(stem, "index.d.ts")]) {
    if (fs.existsSync(candidate)) return candidate
  }
}
