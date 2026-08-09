import fs from "node:fs"
import path from "node:path"

import type { BuildManifest } from "./normalize-build-manifest"
import type { Policy } from "./policy"
import { REPO_ROOT } from "./closure"

function matchesPrefix(value: string, prefix: string) {
  return value === prefix || value.startsWith(`${prefix}/`)
}

function assertStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value
}

export function readBuildManifest(file: string): BuildManifest {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BuildManifest>
  if (typeof value.entry !== "string") throw new Error("entry must be a string")
  const modules = assertStrings(value.modules, "modules")
  const chunks = assertStrings(value.chunks, "chunks")
  if (!value.edges || typeof value.edges !== "object") throw new Error("edges must be an object")
  const staticEdges = assertStrings(value.edges.static, "edges.static")
  const dynamicEdges = assertStrings(value.edges.dynamic, "edges.dynamic")
  return { entry: value.entry, modules, chunks, edges: { static: staticEdges, dynamic: dynamicEdges } }
}

/** Validate emitted build-tool metadata against the same product policy as source. */
export function emittedManifestFindings(policy: Policy, root = REPO_ROOT): string[] {
  if (!policy.emitted) return []
  const file = path.join(root, policy.emitted.file)
  if (!fs.existsSync(file)) return [`missing emitted manifest: ${policy.emitted.file}`]

  let manifest: BuildManifest
  try {
    manifest = readBuildManifest(file)
  } catch (error) {
    return [`invalid emitted manifest ${policy.emitted.file}: ${error instanceof Error ? error.message : String(error)}`]
  }

  const findings: string[] = []
  if (manifest.entry !== policy.entry) findings.push(`entry is ${manifest.entry}; expected ${policy.entry}`)
  if (manifest.modules.length < policy.emitted.minModules) {
    findings.push(`manifest has ${manifest.modules.length} modules; expected at least ${policy.emitted.minModules}`)
  }
  if (manifest.chunks.length < policy.emitted.minChunks) {
    findings.push(`manifest has ${manifest.chunks.length} chunks; expected at least ${policy.emitted.minChunks}`)
  }

  for (const required of policy.emitted.requiredModules) {
    if (!manifest.modules.includes(required)) findings.push(`required emitted module missing: ${required}`)
  }
  for (const forbidden of policy.forbiddenModules) {
    const hits = manifest.modules.filter((module) => matchesPrefix(module, forbidden))
    if (hits.length > 0) findings.push(`forbidden emitted module ${forbidden}: ${hits.join(", ")}`)
  }
  for (const forbidden of policy.forbiddenPackages) {
    const hits = manifest.modules.filter((module) => matchesPrefix(module, forbidden))
    if (hits.length > 0) findings.push(`forbidden emitted package ${forbidden}: ${hits.join(", ")}`)
  }
  for (const marker of policy.emitted.forbiddenChunkMarkers ?? []) {
    const hits = manifest.chunks.filter((chunk) => chunk.toLowerCase().includes(marker.toLowerCase()))
    if (hits.length > 0) findings.push(`forbidden emitted chunk marker ${marker}: ${hits.join(", ")}`)
  }
  return findings
}
