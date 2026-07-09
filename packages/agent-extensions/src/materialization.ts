import fs from "fs/promises"
import path from "path"
import { readFileIfExists, writeFileAtomic } from "./fs-safe"
import { AgentExtensionStateError } from "./state"
import type { PackageSource, HarnessTarget } from "./types"

/**
 * Thrown by the materializer when an unsafe write is requested:
 * overwriting an unmanaged target, missing required server config,
 * MCP-server name conflicts, etc. Centralised so callers (the install
 * route, the materialization tests) can `instanceof`-check against
 * one type.
 *
 * Restored: previously referenced from materialization.ts and
 * materializers/mcp.ts but never declared, which produced
 * "AgentExtensionMaterializationError is not a constructor" failures
 * in materialization.test.ts and materializers/mcp.test.ts.
 */
export class AgentExtensionMaterializationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "agent_extension_materialization_error"
      | "agent_extension_target_path_conflict"
      | "agent_extension_mcp_server_conflict" = "agent_extension_materialization_error",
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = "AgentExtensionMaterializationError"
  }
}

export type MaterializedRuntimeRecord = {
  version: 1
  packages: Record<string, MaterializedExtensionPackage>
}

export type MaterializedExtensionPackage = {
  package_name: string
  source: PackageSource
  resolved_sha: string
  enabled: boolean
  targets: HarnessTarget[]
  components: MaterializedComponent[]
  materialized_at: number
  status: "applied" | "partial" | "failed" | "drifted" | "disabled"
}

export type MaterializedComponent = {
  runner: HarnessTarget
  component: string
  type: "skill" | "mcp" | "plugin" | "hook"
  status: "applied" | "skipped" | "failed" | "drifted"
  reason?: string
  path?: string
  checksum?: string
}

export function materializedRecordPath(root: string) {
  return path.join(root, "materialized.json")
}

export async function readMaterializedRuntimeRecord(file: string): Promise<MaterializedRuntimeRecord> {
  const raw = await readFileIfExists(file)
  if (raw === undefined) return { version: 1, packages: {} }
  let data: Partial<MaterializedRuntimeRecord>
  try {
    data = JSON.parse(raw) as Partial<MaterializedRuntimeRecord>
  } catch (err) {
    throw new AgentExtensionStateError(
      `Materialized Agent Extension record ${file} is not valid JSON; fix or remove it (it is the ownership record that guards deletions): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return {
    version: 1,
    packages: data.packages ?? {},
  }
}

export async function writeMaterializedRuntimeRecord(file: string, record: MaterializedRuntimeRecord) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
  await writeFileAtomic(file, JSON.stringify({
    version: 1,
    packages: Object.fromEntries(Object.entries(record.packages).sort(([a], [b]) => a.localeCompare(b))),
  }, null, 2) + "\n")
}

export function componentOwnedBy(record: MaterializedRuntimeRecord | undefined, targetPath: string, ownerId: string) {
  return record?.packages[ownerId]?.components.some((item) => item.path === targetPath && item.status === "applied") ?? false
}

async function sameRealPath(a: string, b: string) {
  const [left, right] = await Promise.all([
    fs.realpath(a).catch(() => null),
    fs.realpath(b).catch(() => null),
  ])
  return !!left && left === right
}

function agentExtensionCacheKey(input: string) {
  const parts = path.resolve(input).split(path.sep)
  const root = parts.findIndex((part, index) =>
    part === ".agent-extensions" && parts[index + 1] === "cache"
  )
  return root === -1 ? undefined : parts.slice(root + 2).join("/")
}

async function isGeneratedCacheSymlinkToSamePackage(input: {
  sourceDir: string
  targetDir: string
  existing: Awaited<ReturnType<typeof fs.lstat>>
}) {
  if (!input.existing.isSymbolicLink()) return false
  const [source, target] = await Promise.all([
    fs.realpath(input.sourceDir).catch(() => undefined),
    fs.realpath(input.targetDir).catch(() => undefined),
  ])
  if (!source || !target) return false
  const sourceKey = agentExtensionCacheKey(source)
  return !!sourceKey && sourceKey === agentExtensionCacheKey(target)
}

async function emptyDir(target: string) {
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
}

export async function linkOrCopyOwnedDirectory(input: {
  sourceDir: string
  targetDir: string
  ownerId: string
  record?: MaterializedRuntimeRecord
  replaceOwned?: boolean
  symlink?: (source: string, target: string, type: "dir") => Promise<void>
}) {
  if (path.resolve(input.sourceDir) === path.resolve(input.targetDir) || await sameRealPath(input.sourceDir, input.targetDir)) {
    if (componentOwnedBy(input.record, input.targetDir, input.ownerId)) {
      return { status: "applied" as const, path: input.targetDir }
    }
    return { status: "skipped" as const, reason: "source already at target path", path: input.targetDir }
  }
  const existing = await fs.lstat(input.targetDir).catch(() => null)
  if (existing) {
    const owned = componentOwnedBy(input.record, input.targetDir, input.ownerId)
    const adoptable = owned ? false : await isGeneratedCacheSymlinkToSamePackage({
      sourceDir: input.sourceDir,
      targetDir: input.targetDir,
      existing,
    })
    if (!owned && !adoptable) {
      throw new AgentExtensionMaterializationError(
        `Refusing to overwrite unmanaged Agent Extension artifact at ${input.targetDir}`,
        "agent_extension_target_path_conflict",
        {
          ownerId: input.ownerId,
          targetPath: input.targetDir,
        },
      )
    }
    if (owned && !input.replaceOwned) {
      return { status: "drifted" as const, reason: "owned artifact differs from cached source", path: input.targetDir }
    }
  }
  await emptyDir(input.targetDir)
  try {
    await (input.symlink ?? fs.symlink)(input.sourceDir, input.targetDir, "dir")
    return { status: "applied" as const, path: input.targetDir }
  } catch {
    await fs.cp(input.sourceDir, input.targetDir, { recursive: true, force: true })
    return { status: "applied" as const, path: input.targetDir, reason: "copied because symlink failed" }
  }
}

