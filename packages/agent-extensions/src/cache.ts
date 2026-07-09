import fs from "fs/promises"
import path from "path"
import crypto from "crypto"
import { AgentExtensionSourceError, safeRelativePath } from "./source"

export class AgentExtensionCacheError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AgentExtensionCacheError"
  }
}

export function agentExtensionCacheRoot(input: { dataRoot: string }) {
  return path.join(input.dataRoot, "agent-extensions", "cache")
}

function safeSha(input: string) {
  if (!/^[A-Fa-f0-9]{7,64}$/.test(input)) throw new AgentExtensionCacheError("resolved SHA must be a hex string")
  return input.toLowerCase()
}

export function cachePackageRoot(input: {
  resolvedSha: string
  packagePath?: string
  dataRoot: string
}) {
  return path.join(
    agentExtensionCacheRoot({ dataRoot: input.dataRoot }),
    safeSha(input.resolvedSha),
    input.packagePath ? safeRelativePath(input.packagePath, "cache package path") : "",
  )
}

function contained(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = (await fs.readdir(current, { withFileTypes: true }))
    .filter((entry) => !(entry.isDirectory() && entry.name === ".git"))
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(current, entry.name)
    if (entry.isSymbolicLink()) {
      throw new AgentExtensionCacheError(`Cache source symlinks are not supported: ${path.relative(root, full)}`)
    }
    if (entry.isDirectory()) return walkFiles(root, full)
    if (entry.isFile()) return [full]
    return []
  }))
  return nested.flat()
}

export async function digestDirectory(root: string) {
  const hash = crypto.createHash("sha256")
  const realRoot = await fs.realpath(root)
  const files = (await walkFiles(realRoot)).sort((a, b) => path.relative(realRoot, a).localeCompare(path.relative(realRoot, b)))
  for (const file of files) {
    const relative = path.relative(realRoot, file).split(path.sep).join("/")
    hash.update(relative)
    hash.update("\0")
    hash.update(await fs.readFile(file))
    hash.update("\0")
  }
  return hash.digest("hex")
}

export async function copyPackageToCache(input: {
  sourceRoot: string
  resolvedSha: string
  packagePath?: string
  dataRoot: string
}) {
  const packagePath = input.packagePath ? safeRelativePath(input.packagePath, "package path") : undefined
  const source = packagePath ? path.join(input.sourceRoot, packagePath) : input.sourceRoot
  const realSourceRoot = await fs.realpath(input.sourceRoot)
  const realSource = await fs.realpath(source).catch(() => {
    throw new AgentExtensionSourceError("package path must point to an existing directory")
  })
  if (!contained(realSourceRoot, realSource)) throw new AgentExtensionSourceError("package path must stay inside the fetched root")
  if (!await fs.stat(realSource).then((stat) => stat.isDirectory()).catch(() => false)) {
    throw new AgentExtensionSourceError("package path must point to a directory")
  }
  await digestDirectory(realSource)
  const target = cachePackageRoot({
    resolvedSha: input.resolvedSha,
    ...(packagePath ? { packagePath } : {}),
    dataRoot: input.dataRoot,
  })
  // Stage the copy next to the target and rename into place: a crash mid-copy
  // must not leave a partial directory at the cache path, because enable()
  // resolves package roots from here and verifies digests before replaying.
  const staging = `${target}.${crypto.randomBytes(6).toString("hex")}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
  await fs.cp(realSource, staging, {
    recursive: true,
    force: true,
    dereference: false,
    filter: (source) => !path.relative(realSource, source).split(path.sep).includes(".git"),
  })
  try {
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true })
    throw err
  }
  return {
    path: target,
    checksum: await digestDirectory(target),
  }
}
