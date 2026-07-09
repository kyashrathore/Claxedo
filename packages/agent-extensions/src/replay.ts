import { execFile } from "child_process"
import crypto from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { writeFileAtomic } from "./fs-safe"
import { materializeAgentExtensionSnapshot, type AgentExtensionMaterializationInstall } from "./materialize"
import { FIRST_PARTY_AGENT_EXTENSIONS_DIR } from "./types"
import { digestDirectory } from "./cache"
import { githubRepoUrl } from "./fetch"
import { safeRelativePath } from "./source"

// Runtime package-acquisition adapter: persists the pushed snapshot,
// resolves/fetches verified package roots, then delegates all disk
// materialization to the canonical materializer.
export type RuntimeAgentExtensions = {
  version: 1
  installs: Array<{
    desired: Record<string, unknown>
    lock?: Record<string, unknown>
    status?: string
    components?: Array<Record<string, unknown>>
  }>
}
type RuntimeInstall = RuntimeAgentExtensions["installs"][number]
type ExecFile = (file: string, args: string[], options?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>
export type ReplayOptions = {
  execFile?: ExecFile
  tempRoot?: string
  homeDir?: string
  stateRoot?: string
  packageRoots?: Record<string, string>
  now?: number | (() => number)
}

function projectDirDefault() {
  return process.env.CLAXEDO_WR_DIRECTORY ?? process.cwd()
}

function execFileDefault(file: string, args: string[], options?: { cwd?: string }) {
  if (file !== "git") throw new Error(`Unsupported Agent Extension exec binary: ${file}`)
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, {
      cwd: options?.cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30_000,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(err)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function sorted<T>(input: Record<string, T>) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) as Record<string, T>
}

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function str(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function stringList(input: unknown) {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
}

function packageSource(input: unknown) {
  const value = rec(input)
  return {
    type: str(value.type) ?? "unknown",
    ...(typeof value.owner === "string" ? { owner: value.owner } : {}),
    ...(typeof value.repo === "string" ? { repo: value.repo } : {}),
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.package_path === "string" ? { package_path: value.package_path } : {}),
  }
}

function relative(input: string | undefined) {
  if (!input) return undefined
  try {
    return safeRelativePath(input, "Agent Extension package path")
  } catch {
    throw new Error("Agent Extension package path must stay inside the source root")
  }
}

function source(input: RuntimeInstall) {
  const value = rec(input.desired.source)
  if (value.type === "project") {
    return {
      type: "project" as const,
      packagePath: relative(str(value.package_path)) ?? FIRST_PARTY_AGENT_EXTENSIONS_DIR,
    }
  }
  const owner = str(value.owner)
  const repo = str(value.repo)
  if (value.type !== "github" || !owner || !repo) throw new Error(`Unsupported Agent Extension source for ${String(input.desired.id ?? "unknown")}`)
  return {
    type: "github" as const,
    owner,
    repo,
    packagePath: relative(str(value.package_path)),
  }
}

function expectedDigest(input: RuntimeInstall) {
  const lock = rec(input.lock)
  const component = str(rec(lock.component_digests).package)
  return component ?? str(rec(lock.manifest_digests).package)
}

async function verifyPackageDigest(input: {
  install: RuntimeInstall
  packageRoot: string
}) {
  const expected = expectedDigest(input.install)
  if (!expected) return
  const actual = await digestDirectory(input.packageRoot)
  if (actual !== expected) {
    throw new Error(`Agent Extension ${String(input.install.desired.id ?? "unknown")} cache checksum mismatch`)
  }
}

// The resolved SHA comes from a pushed snapshot; it is used both as a git
// argument and as a cache path segment, so anything but a hex commit id
// (option injection, path traversal) must be rejected before use.
function resolvedSha(input: RuntimeInstall) {
  const sha = str(input.lock?.resolved_sha)
  if (!sha) throw new Error(`Agent Extension ${String(input.desired.id ?? "unknown")} is missing resolved SHA`)
  if (!/^[A-Fa-f0-9]{7,64}$/.test(sha)) {
    throw new Error(`Agent Extension ${String(input.desired.id ?? "unknown")} resolved SHA must be a hex commit id`)
  }
  return sha.toLowerCase()
}

async function fetchToCache(input: {
  install: RuntimeInstall
  cacheRoot: string
  execFile: ExecFile
  tempRoot: string
}) {
  const info = source(input.install)
  if (info.type !== "github") throw new Error(`Unsupported Agent Extension source for ${String(input.install.desired.id ?? "unknown")}`)
  const sha = resolvedSha(input.install)
  const shaRoot = path.join(input.cacheRoot, sha)
  const target = info.packagePath ? path.join(shaRoot, info.packagePath) : shaRoot
  if (await fs.stat(target).then((stat) => stat.isDirectory()).catch(() => false)) return target
  const root = await fs.mkdtemp(path.join(input.tempRoot, "claxedo-runtime-extension-"))
  try {
    await input.execFile("git", ["init", root])
    await input.execFile("git", ["remote", "add", "origin", githubRepoUrl({
      type: "github",
      owner: info.owner,
      repo: info.repo,
    })], { cwd: root })
    await input.execFile("git", ["fetch", "--depth", "1", "origin", sha], { cwd: root })
    await input.execFile("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: root })
    const sourceRoot = info.packagePath ? path.join(root, info.packagePath) : root
    // Copy into a sibling temp dir and rename into place so a crash mid-copy
    // never leaves a partial directory at the final cache path — the
    // exists-check above would keep returning it and every replay would fail
    // its digest verification with no way to self-heal.
    const staging = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
    await fs.cp(sourceRoot, staging, {
      recursive: true,
      force: true,
      filter: (source) => !path.relative(sourceRoot, source).split(path.sep).includes(".git"),
    })
    try {
      await fs.rm(target, { recursive: true, force: true })
      await fs.rename(staging, target)
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true })
      throw err
    }
    return target
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function resolveProjectPackageRoot(input: {
  install: RuntimeInstall
  projectDir: string
}) {
  const info = source(input.install)
  if (info.type !== "project") return undefined
  const root = path.join(input.projectDir, info.packagePath)
  if (!await fs.stat(root).then((stat) => stat.isDirectory()).catch(() => false)) {
    throw new Error(`Project Agent Extension root does not exist: ${info.packagePath}`)
  }
  return root
}

function canonicalInstall(input: RuntimeInstall): AgentExtensionMaterializationInstall | undefined {
  if (typeof input.desired.id !== "string") return
  return {
    desired: {
      id: input.desired.id,
      ...(typeof input.desired.package_name === "string" ? { package_name: input.desired.package_name } : {}),
      source: packageSource(input.desired.source),
      ...(typeof input.desired.scope === "string" ? { scope: input.desired.scope } : {}),
      ...(typeof input.desired.enabled === "boolean" ? { enabled: input.desired.enabled } : {}),
      targets: stringList(input.desired.targets),
    },
    ...(input.lock ? { lock: { ...(typeof input.lock.resolved_sha === "string" ? { resolved_sha: input.lock.resolved_sha } : {}) } } : {}),
    ...(typeof input.status === "string" ? { status: input.status } : {}),
  }
}

async function packageRoots(input: {
  installs: RuntimeInstall[]
  projectDir: string
  cacheRoot: string
  execFile: ExecFile
  tempRoot: string
  packageRoots?: Record<string, string>
}) {
  const entries = (await Promise.all(input.installs.map(async (install) => {
    if (typeof install.desired.id !== "string") return []
    const provided = input.packageRoots?.[install.desired.id]
      ?? await resolveProjectPackageRoot({
        install,
        projectDir: input.projectDir,
      })
    if (provided) {
      await verifyPackageDigest({ install, packageRoot: provided })
      return [[install.desired.id, provided]]
    }
    const fetchInput = {
      install,
      cacheRoot: input.cacheRoot,
      execFile: input.execFile,
      tempRoot: input.tempRoot,
    }
    const packageRoot = await fetchToCache(fetchInput)
    try {
      await verifyPackageDigest({ install, packageRoot })
    } catch {
      // A cache entry that no longer matches its lock digest (partial copy
      // from an old crash, manual edit) would otherwise fail every future
      // replay: discard it and fetch fresh before giving up.
      await fs.rm(packageRoot, { recursive: true, force: true })
      const refetched = await fetchToCache(fetchInput)
      await verifyPackageDigest({ install, packageRoot: refetched })
      return [[install.desired.id, refetched]]
    }
    return [[install.desired.id, packageRoot]]
  }))).flat() as Array<[string, string]>
  return sorted(Object.fromEntries(entries) as Record<string, string>)
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// A crashed replay leaves the lock directory behind; treat locks older than
// this as stale and take them over instead of spinning forever.
const REPLAY_LOCK_STALE_MS = 10 * 60 * 1000

async function withReplayLock(root: string, fn: () => Promise<void>) {
  const lock = path.join(root, ".replay-lock")
  await fs.mkdir(root, { recursive: true, mode: 0o755 })
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 0o755 })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      const stat = await fs.stat(lock).catch(() => undefined)
      if (stat && Date.now() - stat.mtimeMs > REPLAY_LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true })
        continue
      }
      await wait(100)
    }
  }
  try {
    await fn()
  } finally {
    await fs.rm(lock, { recursive: true, force: true })
  }
}

async function applyRuntimeAgentExtensionsNow(input: RuntimeAgentExtensions | undefined, projectDir = projectDirDefault(), options: ReplayOptions = {}) {
  if (!input) return
  const root = options.stateRoot ?? path.join(projectDir, ".agent-extensions")
  await withReplayLock(root, async () => {
    const installs = input.installs
    const enabledInstalls = installs.filter((item) => item.desired.enabled !== false)
    await writeFileAtomic(path.join(root, "installed.json"), JSON.stringify({
      version: 1,
      installs: installs.map((item) => item.desired).sort((a, b) =>
        String(a.id ?? "").localeCompare(String(b.id ?? "")),
      ),
    }, null, 2) + "\n")
    await writeFileAtomic(path.join(root, "lock.json"), JSON.stringify({
      version: 1,
      packages: sorted(Object.fromEntries(installs.flatMap((item) =>
        item.lock && typeof item.desired.id === "string" ? [[item.desired.id, item.lock]] : [],
      ))),
    }, null, 2) + "\n")
    await materializeAgentExtensionSnapshot({
      installs: installs.flatMap((item) => canonicalInstall(item) ?? []),
      packageRoots: await packageRoots({
        installs: enabledInstalls,
        projectDir,
        cacheRoot: path.join(root, "cache"),
        execFile: options.execFile ?? execFileDefault,
        tempRoot: options.tempRoot ?? os.tmpdir(),
        ...(options.packageRoots ? { packageRoots: options.packageRoots } : {}),
      }),
      projectDir,
      stateRoot: root,
      homeDir: options.homeDir ?? os.homedir(),
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
  })
}

let applyQueue: Promise<void> = Promise.resolve()

export async function applyRuntimeAgentExtensions(input: RuntimeAgentExtensions | undefined, projectDir = projectDirDefault(), options: ReplayOptions = {}) {
  const next = applyQueue.then(() => applyRuntimeAgentExtensionsNow(input, projectDir, options))
  applyQueue = next.catch(() => {})
  return next
}
