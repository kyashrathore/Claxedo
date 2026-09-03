import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { lstat, readdir, realpath } from "node:fs/promises"
import { appRoot, repoRoot } from "./storage"

type MemoryProvenanceBase = {
  capturedAt: string
  sourceSha256: string
  sourceFileCount: number
  sourceRoots: string[]
  appBuildSha256: string
  appCommand: string
  browser: { name: "chromium"; version: string }
  host: {
    hostname: string
    platform: string
    release: string
    architecture: string
    cpu: string
    logicalCpuCount: number
    totalMemoryBytes: number
  }
  command: string[]
}

export type GitSourceControl = {
  sourceControlMode: "git"
  commit: string
  gitTree: string
  dirty: boolean
  statusSha256: string
}

export type RawSourceControl = {
  sourceControlMode: "crabbox-raw"
  rawSyncFingerprint: string
}

export type SourceControlProvenance = GitSourceControl | RawSourceControl
export type MemoryProvenance = MemoryProvenanceBase & SourceControlProvenance

export type AuthoritativeSourceIdentity =
  | ({ mode: "git"; sourceSha256: string } & Omit<GitSourceControl, "sourceControlMode">)
  | ({ mode: "crabbox-raw"; sourceSha256: string } & Omit<RawSourceControl, "sourceControlMode">)

export type SourceDigest = {
  sha256: string
  files: number
  roots: string[]
}

/**
 * These packages are not optional discovery hints. They are the minimum source
 * surface consumed by the renderer build and its dev resolver. The closure
 * resolver below follows every remaining in-repo dependency from the two entry
 * packages and rejects a manifest that does not contain these exact owners.
 */
export const MEMORY_RUNTIME_REQUIRED_PACKAGES = {
  "@claxedo/app": "packages/claxedo-app",
  "@opencode-ai/session-ui": "packages/session-ui",
  "@opencode-ai/ui": "packages/ui",
  "@opencode-ai/core": "packages/core",
  "@opencode-ai/sdk": "packages/sdk/js",
  "@claxedo/agent-event-runtime": "packages/agent-event-runtime",
  "@claxedo/usage-contract": "packages/usage-contract",
} as const

const MEMORY_RUNTIME_ENTRY_PACKAGES = ["@claxedo/app", "@opencode-ai/session-ui"] as const

/** Directory names aligned with the repository's generated/runtime ignores. */
const GENERATED_DIRECTORIES = new Set([
  ".agent-extensions",
  ".artifacts",
  ".astro",
  ".build",
  ".cache",
  ".claxedo",
  ".dev-docs",
  ".direnv",
  ".mermaid-wiring",
  ".next",
  ".output",
  ".sandbox-build",
  ".scripts",
  ".serena",
  ".sst",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".wrangler",
  "blob-report",
  "build",
  "coverage",
  "dev-docs",
  "logs",
  "node_modules",
  "out",
  "playground",
  "playwright-report",
  "report",
  "reports",
  "result",
  "screenshots",
  "sidecars",
  "storybook-static",
  "target",
  "test-results",
  "tmp",
  "ts-dist",
])

function isGeneratedDirectory(name: string, relativeName: string) {
  if (GENERATED_DIRECTORIES.has(name) || name === "dist" || name.startsWith("dist-")) return true
  // Tracked baselines/run logs describe measurements; the renderer build does
  // not consume them and a completed run must not change the next source hash.
  return relativeName === "packages/claxedo-app/perf-harness/data"
}

function isGeneratedFile(name: string, relativeName: string) {
  if (name === ".DS_Store" || name === "Thumbs.db" || name.endsWith("~")) return true
  if (/\.(?:bun-build|heapsnapshot|log|pid|swp|swo|tsbuildinfo)$/u.test(name)) return true
  if (name === ".env" || name === ".env.local" || /^\.env\..*\.local$/u.test(name)) return true
  if (name === "skills-lock.json" && relativeName.startsWith("packages/claxedo-app/")) return true
  if (relativeName === "packages/claxedo-app/.claude/settings.local.json") return true
  return relativeName === "packages/claxedo-app/.opencode/processes.schema.json" ||
    relativeName === "packages/claxedo-app/.opencode/processes.jsonc"
}

export function digestNamedBytes(entries: readonly { name: string; bytes: Uint8Array | string }[]) {
  const hash = createHash("sha256")
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name).update("\0").update(entry.bytes).update("\0")
  }
  return hash.digest("hex")
}

function isWithin(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function requiredDirectory(repository: string, relativeDirectory: string) {
  const repositoryReal = await realpath(repository)
  const absolute = path.resolve(repository, relativeDirectory)
  const info = await lstat(absolute).catch(() => undefined)
  if (!info) throw new Error(`required memory provenance root is missing: ${relativeDirectory}`)
  if (info.isSymbolicLink()) throw new Error(`required memory provenance root is symlinked: ${relativeDirectory}`)
  if (!info.isDirectory()) throw new Error(`required memory provenance root is not a directory: ${relativeDirectory}`)
  const resolved = await realpath(absolute)
  if (!isWithin(repositoryReal, resolved)) {
    throw new Error(`required memory provenance root escapes repository: ${relativeDirectory}`)
  }
  return { absolute, resolved }
}

type NamedBytes = { name: string; bytes: Uint8Array }

async function strictFiles(input: {
  repositoryReal: string
  absoluteDirectory: string
  relativeDirectory: string
  excludeGenerated: boolean
}): Promise<NamedBytes[]> {
  const entries = await readdir(input.absoluteDirectory, { withFileTypes: true })
  const result: NamedBytes[] = []
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const relativeName = path.posix.join(input.relativeDirectory, entry.name)
    const absoluteName = path.join(input.absoluteDirectory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`memory provenance does not follow nested symlink: ${relativeName}`)
    if (entry.isDirectory()) {
      if (input.excludeGenerated && isGeneratedDirectory(entry.name, relativeName)) continue
      result.push(...await strictFiles({
        ...input,
        absoluteDirectory: absoluteName,
        relativeDirectory: relativeName,
      }))
      continue
    }
    if (input.excludeGenerated && isGeneratedFile(entry.name, relativeName)) continue
    if (!entry.isFile()) throw new Error(`unsupported memory provenance entry: ${relativeName}`)
    const resolved = await realpath(absoluteName)
    if (!isWithin(input.repositoryReal, resolved)) throw new Error(`memory provenance file escapes repository: ${relativeName}`)
    result.push({ name: relativeName, bytes: new Uint8Array(await Bun.file(resolved).arrayBuffer()) })
  }
  return result
}

type WorkspacePackage = {
  name: string
  relativeDirectory: string
  manifest: Record<string, unknown>
}

async function packageManifestPaths(repository: string, absoluteDirectory: string, relativeDirectory: string): Promise<string[]> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const relativeName = path.posix.join(relativeDirectory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`workspace package discovery does not follow symlink: ${relativeName}`)
    if (entry.isDirectory()) {
      if (!isGeneratedDirectory(entry.name, relativeName)) {
        result.push(...await packageManifestPaths(repository, path.join(absoluteDirectory, entry.name), relativeName))
      }
      continue
    }
    if (entry.isFile() && entry.name === "package.json") result.push(relativeName)
  }
  return result
}

async function workspacePackages(repository: string) {
  const packagesRoot = await requiredDirectory(repository, "packages")
  const manifests = await packageManifestPaths(repository, packagesRoot.absolute, "packages")
  const packages = new Map<string, WorkspacePackage>()
  for (const manifestPath of manifests) {
    const manifest = await Bun.file(path.join(repository, manifestPath)).json() as Record<string, unknown>
    if (typeof manifest.name !== "string") continue
    const relativeDirectory = path.posix.dirname(manifestPath)
    const existing = packages.get(manifest.name)
    if (existing) throw new Error(`duplicate workspace package ${manifest.name}: ${existing.relativeDirectory}, ${relativeDirectory}`)
    packages.set(manifest.name, { name: manifest.name, relativeDirectory, manifest })
  }
  return packages
}

function dependencyEntries(manifest: Record<string, unknown>) {
  const result = new Map<string, string>()
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const) {
    const value = manifest[field]
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    for (const [name, specifier] of Object.entries(value)) {
      if (typeof specifier === "string") result.set(name, specifier)
    }
  }
  return result
}

export async function resolveMemorySourceRoots(repository = repoRoot) {
  const packages = await workspacePackages(repository)
  const queue: string[] = [...MEMORY_RUNTIME_ENTRY_PACKAGES]
  const closure = new Set<string>()
  while (queue.length > 0) {
    const name = queue.shift()!
    if (closure.has(name)) continue
    const owner = packages.get(name)
    if (!owner) throw new Error(`required runtime workspace package is missing: ${name}`)
    closure.add(name)
    for (const [dependency, specifier] of dependencyEntries(owner.manifest)) {
      if (packages.has(dependency)) queue.push(dependency)
      else if (specifier.startsWith("workspace:")) {
        throw new Error(`${name} has unresolved workspace dependency: ${dependency}`)
      }
    }
  }

  for (const [name, expectedDirectory] of Object.entries(MEMORY_RUNTIME_REQUIRED_PACKAGES)) {
    const owner = packages.get(name)
    if (!owner || owner.relativeDirectory !== expectedDirectory) {
      throw new Error(`runtime source owner mismatch for ${name}: expected ${expectedDirectory}, received ${owner?.relativeDirectory ?? "missing"}`)
    }
    if (!closure.has(name)) throw new Error(`runtime dependency closure omitted required package: ${name}`)
  }
  return [...closure].map((name) => packages.get(name)!.relativeDirectory).toSorted()
}

/** Hash one strict, derived source surface in both Git and Crabbox raw modes. */
export async function scanMemorySource(repository = repoRoot): Promise<SourceDigest> {
  const roots = await resolveMemorySourceRoots(repository)
  const repositoryReal = await realpath(repository)
  const entries: NamedBytes[] = []
  for (const relativeDirectory of roots) {
    const root = await requiredDirectory(repository, relativeDirectory)
    entries.push(...await strictFiles({
      repositoryReal,
      absoluteDirectory: root.absolute,
      relativeDirectory,
      excludeGenerated: true,
    }))
  }
  if (entries.length === 0) throw new Error("memory provenance source closure is empty")
  return { sha256: digestNamedBytes(entries), files: entries.length, roots }
}

async function git(directory: string, args: string[]) {
  const child = Bun.spawn({ cmd: ["git", "-C", directory, ...args], stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`)
  return stdout
}

async function rawSyncFingerprint(directory: string) {
  const relativeName = ".crabbox/sync-fingerprint"
  const absoluteName = path.join(directory, relativeName)
  const info = await lstat(absoluteName).catch(() => undefined)
  if (!info) return undefined
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${relativeName} must be a regular file`)
  const resolved = await realpath(absoluteName)
  if (!isWithin(await realpath(directory), resolved)) throw new Error(`${relativeName} escapes repository`)
  const fingerprint = (await Bun.file(resolved).text()).trim()
  if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new Error(`${relativeName} is not a sha256 fingerprint`)
  return fingerprint
}

export async function captureSourceControl(directory = repoRoot): Promise<SourceControlProvenance> {
  // A Crabbox raw sync is authoritative even if a diagnostic later added Git
  // metadata. The sync fingerprint describes the bytes Crabbox transferred;
  // synthesizing `.git` must never silently relabel that workspace as Git.
  const fingerprint = await rawSyncFingerprint(directory)
  if (fingerprint) return { sourceControlMode: "crabbox-raw", rawSyncFingerprint: fingerprint }

  const hasGitMetadata = await lstat(path.join(directory, ".git")).then(() => true).catch(() => false)
  if (!hasGitMetadata) throw new Error("memory provenance requires Git metadata or a Crabbox raw sync fingerprint")
  const [commit, gitTree, status] = await Promise.all([
    git(directory, ["rev-parse", "HEAD"]).then((value) => value.trim()),
    git(directory, ["rev-parse", "HEAD^{tree}"]).then((value) => value.trim()),
    git(directory, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ])
  return {
    sourceControlMode: "git",
    commit,
    gitTree,
    dirty: status.trim().length > 0,
    statusSha256: createHash("sha256").update(status).digest("hex"),
  }
}

export async function digestRequiredMemoryDirectory(repository: string, relativeDirectory: string) {
  const root = await requiredDirectory(repository, relativeDirectory)
  const entries = await strictFiles({
    repositoryReal: await realpath(repository),
    absoluteDirectory: root.absolute,
    relativeDirectory,
    excludeGenerated: false,
  })
  if (entries.length === 0) throw new Error(`required memory provenance root is empty: ${relativeDirectory}`)
  return digestNamedBytes(entries)
}

export function authoritativeSourceIdentity(provenance: MemoryProvenance): AuthoritativeSourceIdentity {
  if (provenance.sourceControlMode === "crabbox-raw") {
    return {
      mode: provenance.sourceControlMode,
      sourceSha256: provenance.sourceSha256,
      rawSyncFingerprint: provenance.rawSyncFingerprint,
    }
  }
  return {
    mode: provenance.sourceControlMode,
    sourceSha256: provenance.sourceSha256,
    commit: provenance.commit,
    gitTree: provenance.gitTree,
    dirty: provenance.dirty,
    statusSha256: provenance.statusSha256,
  }
}

export function memoryProvenanceStable(start: MemoryProvenance, end: MemoryProvenance) {
  if (start.appBuildSha256 !== end.appBuildSha256 || start.sourceSha256 !== end.sourceSha256) return false
  if (start.sourceControlMode !== end.sourceControlMode) return false
  if (start.sourceControlMode === "crabbox-raw" && end.sourceControlMode === "crabbox-raw") {
    return start.rawSyncFingerprint === end.rawSyncFingerprint
  }
  if (start.sourceControlMode === "git" && end.sourceControlMode === "git") {
    return start.commit === end.commit && start.gitTree === end.gitTree && start.dirty === end.dirty &&
      start.statusSha256 === end.statusSha256
  }
  return false
}

export async function captureMemoryProvenance(input: {
  browserVersion: string
  appCommand: string
}): Promise<MemoryProvenance> {
  const [sourceControl, source, appBuildSha256] = await Promise.all([
    captureSourceControl(),
    scanMemorySource(),
    digestRequiredMemoryDirectory(repoRoot, path.relative(repoRoot, path.join(appRoot, "dist"))),
  ])
  return {
    capturedAt: new Date().toISOString(),
    ...sourceControl,
    sourceSha256: source.sha256,
    sourceFileCount: source.files,
    sourceRoots: source.roots,
    appBuildSha256,
    appCommand: input.appCommand,
    browser: { name: "chromium", version: input.browserVersion },
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      cpu: os.cpus()[0]?.model ?? "unknown",
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    command: process.argv,
  } as MemoryProvenance
}
