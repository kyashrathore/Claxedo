import fs from "fs/promises"
import os from "os"
import path from "path"
import { cachePackageRoot, digestDirectory } from "./cache"
import { fetchGitHubPackageToCache } from "./fetch"
import {
  disableAgentExtension,
  enableAgentExtension,
  installCachedAgentExtension,
  installGitHubAgentExtension,
  uninstallAgentExtension,
  updateAgentExtension,
  type AgentExtensionLifecycleInput,
  type InstallCachedAgentExtensionInput,
  type InstallGitHubAgentExtensionInput,
} from "./install"
import { readExtensionLock } from "./lock"
import {
  materializedRecordPath,
  readMaterializedRuntimeRecord,
  type MaterializedRuntimeRecord,
} from "./materialization"
import { applyRuntimeAgentExtensions } from "./replay"
import {
  getRuntimeAgentExtensionsSnapshot,
  type AgentExtensionPolicyOverride,
  type RuntimeAgentExtensionsSnapshotInput,
  type RuntimeAgentExtensionsSnapshot,
} from "./runtime-config"
import {
  installedStatePath,
  readDesiredExtensionState,
  type DesiredExtensionState,
} from "./state"
import { agentExtensionFiles } from "./storage"
import { isHarnessTarget, type AgentExtensionScope, type MaterializedAgentExtensionScope, type HarnessTarget } from "./types"
import type { WorkspaceAgentExtensionRecord } from "./workspace"

export type AgentExtensionsOptions = {
  projectDir?: string
  homeDir?: string
  dataRoot?: string
  scope?: MaterializedAgentExtensionScope
  now?: number
}

export type AgentExtensionsListResult = {
  desired: DesiredExtensionState
  materialized: MaterializedRuntimeRecord
}

export type AgentExtensionsDoctorIssue = {
  code: string
  message: string
  id?: string
  path?: string
}

export type AgentExtensionsDoctorResult = {
  ok: boolean
  issues: AgentExtensionsDoctorIssue[]
}

function resolved(input: AgentExtensionsOptions = {}) {
  const homeDir = input.homeDir ?? os.homedir()
  return {
    projectDir: path.resolve(input.projectDir ?? process.cwd()),
    homeDir,
    dataRoot: path.resolve(input.dataRoot ?? path.join(homeDir, ".claxedo")),
    scope: input.scope ?? "project" as MaterializedAgentExtensionScope,
    ...(input.now !== undefined ? { now: input.now } : {}),
  }
}

function withDefaults(input: AgentExtensionsOptions & { id: string }): AgentExtensionLifecycleInput {
  const defaults = resolved(input)
  return {
    id: input.id,
    scope: input.scope ?? defaults.scope,
    projectDir: defaults.projectDir,
    dataRoot: defaults.dataRoot,
    homeDir: defaults.homeDir,
    ...(input.now !== undefined ? { now: input.now } : defaults.now !== undefined ? { now: defaults.now } : {}),
  }
}

function installDefaults(input: AgentExtensionsOptions) {
  const defaults = resolved(input)
  return {
    scope: input.scope ?? defaults.scope,
    projectDir: defaults.projectDir,
    dataRoot: defaults.dataRoot,
    homeDir: defaults.homeDir,
    ...(input.now !== undefined ? { now: input.now } : defaults.now !== undefined ? { now: defaults.now } : {}),
  }
}

function projectSourceRoot(input: {
  projectDir: string
  packagePath: string
}) {
  return path.resolve(input.projectDir, input.packagePath)
}

function targetList(input: unknown): HarnessTarget[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new Error("targets must be an array")
  const targets = input.filter(isHarnessTarget)
  if (targets.length !== input.length) throw new Error("targets include unsupported harness names")
  return targets
}

async function cachedInstallFromProjectPath(input: {
  packagePath: string
  targets?: HarnessTarget[]
  id?: string
} & AgentExtensionsOptions) {
  const defaults = installDefaults(input)
  const sourceRoot = defaults.projectDir
  const packageRoot = projectSourceRoot({
    projectDir: defaults.projectDir,
    packagePath: input.packagePath,
  })
  return installCachedAgentExtension({
    sourceRoot,
    source: {
      type: "project",
      package_path: input.packagePath,
    },
    resolvedSha: await digestDirectory(packageRoot),
    packagePath: input.packagePath,
    ...defaults,
    ...(input.targets ? { targets: input.targets } : {}),
    ...(input.id ? { id: input.id } : {}),
  })
}

function stateFiles(input: AgentExtensionsOptions & { scope?: AgentExtensionScope } = {}) {
  const defaults = resolved(input)
  return agentExtensionFiles({
    scope: input.scope ?? defaults.scope,
    projectDir: defaults.projectDir,
    dataRoot: defaults.dataRoot,
  })
}

async function list(input: AgentExtensionsOptions = {}): Promise<AgentExtensionsListResult> {
  const files = stateFiles(input)
  const [desired, materialized] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readMaterializedRuntimeRecord(files.materialized),
  ])
  return { desired, materialized }
}

// Lock records come from disk and may be malformed (non-hex SHA, unsafe
// package path); doctor must report them, not crash on them.
function lockCacheRoot(locked: { resolved_sha: string; package_path?: string }, dataRoot: string) {
  try {
    return cachePackageRoot({
      resolvedSha: locked.resolved_sha,
      ...(locked.package_path ? { packagePath: locked.package_path } : {}),
      dataRoot,
    })
  } catch {
    return undefined
  }
}

// State readers throw on corrupted (unparseable) files so lifecycle commands
// never mistake corruption for emptiness. Doctor is the tool for diagnosing
// exactly that state, so it downgrades those throws to reported issues.
async function readOrReport<T>(read: Promise<T>, empty: T, file: string, issues: AgentExtensionsDoctorIssue[]) {
  try {
    return await read
  } catch (err) {
    issues.push({
      code: "corrupt_state_file",
      message: err instanceof Error ? err.message : String(err),
      path: file,
    })
    return empty
  }
}

async function doctor(input: AgentExtensionsOptions = {}): Promise<AgentExtensionsDoctorResult> {
  const defaults = resolved(input)
  const files = stateFiles(input)
  const corruption: AgentExtensionsDoctorIssue[] = []
  const [desired, lock, materialized] = await Promise.all([
    readOrReport(readDesiredExtensionState(files.installed), { version: 1 as const, installs: [] }, files.installed, corruption),
    readOrReport(readExtensionLock(files.lock), { version: 1 as const, packages: {} }, files.lock, corruption),
    readOrReport(readMaterializedRuntimeRecord(files.materialized), { version: 1 as const, packages: {} }, files.materialized, corruption),
  ])
  const desiredIds = new Set(desired.installs.map((item) => item.id))
  const lockIds = new Set(Object.keys(lock.packages))
  const issues: AgentExtensionsDoctorIssue[] = [
    ...corruption,
    ...desired.installs.flatMap((item) => item.targets.every(isHarnessTarget) ? [] : [{
      code: "invalid_targets",
      message: `Agent Extension ${item.id} contains unsupported targets`,
      id: item.id,
    }]),
    ...desired.installs.flatMap((item) => item.enabled && item.source.type === "github" && !lock.packages[item.id] ? [{
      code: "missing_lock",
      message: `Enabled GitHub Agent Extension ${item.id} has no lock record`,
      id: item.id,
    }] : []),
    ...Object.entries(lock.packages).flatMap(([id, locked]) => {
      const cacheRoot = lockCacheRoot(locked, defaults.dataRoot)
      return desiredIds.has(id)
        ? []
        : [{
            code: "orphaned_lock",
            message: `Lock record ${id} has no desired install`,
            id,
            ...(cacheRoot ? { path: cacheRoot } : {}),
          }]
    }),
    ...Object.keys(materialized.packages).flatMap((id) => desiredIds.has(id) || lockIds.has(id) ? [] : [{
      code: "orphaned_materialized_record",
      message: `Materialized record ${id} has no desired install or lock record`,
      id,
    }]),
  ]
  for (const [id, locked] of Object.entries(lock.packages)) {
    const cacheRoot = lockCacheRoot(locked, defaults.dataRoot)
    if (!cacheRoot) {
      issues.push({
        code: "invalid_lock_record",
        message: `Lock record ${id} has an invalid resolved SHA or package path`,
        id,
      })
      continue
    }
    if (!await fs.stat(cacheRoot).then((stat) => stat.isDirectory()).catch(() => false)) {
      issues.push({
        code: "missing_cache",
        message: `Cache root for ${id} is missing`,
        id,
        path: cacheRoot,
      })
    }
  }
  for (const [id, pkg] of Object.entries(materialized.packages)) {
    for (const component of pkg.components) {
      if (!component.path || component.status !== "applied") continue
      const stat = await fs.lstat(component.path).catch(() => undefined)
      if (!stat) {
        issues.push({
          code: "missing_materialized_path",
          message: `Materialized path for ${id}/${component.component} is missing`,
          id,
          path: component.path,
        })
        continue
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(component.path).catch(() => undefined)
        if (!target) {
          issues.push({
            code: "stale_materialized_symlink",
            message: `Materialized symlink for ${id}/${component.component} is stale`,
            id,
            path: component.path,
          })
        }
      }
    }
  }
  return {
    ok: issues.length === 0,
    issues,
  }
}

export function createAgentExtensions(options: AgentExtensionsOptions = {}) {
  const defaults = resolved(options)
  return {
    install(input: {
      source: string
      targets?: HarnessTarget[]
      id?: string
    } & AgentExtensionsOptions) {
      return installGitHubAgentExtension({
        source: input.source,
        ...installDefaults({ ...defaults, ...input }),
        ...(input.targets ? { targets: input.targets } : {}),
        ...(input.id ? { id: input.id } : {}),
      } satisfies InstallGitHubAgentExtensionInput)
    },
    installCached(input: {
      sourceRoot?: string
      packagePath?: string
      source?: InstallCachedAgentExtensionInput["source"]
      resolvedSha?: string
      targets?: HarnessTarget[]
      id?: string
      replaceOwned?: boolean
    } & AgentExtensionsOptions) {
      if (input.packagePath && !input.sourceRoot) {
        return cachedInstallFromProjectPath({
          ...defaults,
          ...input,
          packagePath: input.packagePath,
        })
      }
      if (!input.sourceRoot) throw new Error("sourceRoot or packagePath is required")
      const sourceRoot = path.resolve(input.sourceRoot)
      return digestDirectory(sourceRoot).then((checksum) => installCachedAgentExtension({
        sourceRoot,
        source: input.source ?? {
          type: "project",
          package_path: input.packagePath ?? path.basename(sourceRoot),
        },
        resolvedSha: input.resolvedSha ?? checksum,
        ...installDefaults({ ...defaults, ...input }),
        ...(input.targets ? { targets: input.targets } : {}),
        ...(input.id ? { id: input.id } : {}),
        ...(input.replaceOwned !== undefined ? { replaceOwned: input.replaceOwned } : {}),
      }))
    },
    list(input: AgentExtensionsOptions = {}) {
      return list({ ...defaults, ...input })
    },
    update(input: { id: string } & AgentExtensionsOptions) {
      return updateAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }))
    },
    enable(input: { id: string } & AgentExtensionsOptions) {
      return enableAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }))
    },
    disable(input: { id: string } & AgentExtensionsOptions) {
      return disableAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }))
    },
    uninstall(input: { id: string } & AgentExtensionsOptions) {
      return uninstallAgentExtension(withDefaults({ ...defaults, ...input, id: input.id }))
    },
    snapshot(input: {
      workspaceInstalls?: WorkspaceAgentExtensionRecord[]
      policyOverrides?: AgentExtensionPolicyOverride[]
    } & AgentExtensionsOptions = {}): Promise<RuntimeAgentExtensionsSnapshot> {
      const settings = resolved({ ...defaults, ...input })
      return getRuntimeAgentExtensionsSnapshot({
        projectDir: settings.projectDir,
        scope: settings.scope,
        dataRoot: settings.dataRoot,
      } satisfies RuntimeAgentExtensionsSnapshotInput, {
        ...(input.workspaceInstalls ? { workspaceInstalls: input.workspaceInstalls } : {}),
        ...(input.policyOverrides ? { policyOverrides: input.policyOverrides } : {}),
      })
    },
    async materialize(input: AgentExtensionsOptions = {}) {
      const settings = resolved({ ...defaults, ...input })
      return applyRuntimeAgentExtensions(await getRuntimeAgentExtensionsSnapshot({
        projectDir: settings.projectDir,
        scope: settings.scope,
        dataRoot: settings.dataRoot,
      }), settings.projectDir, {
        homeDir: settings.homeDir,
        stateRoot: stateFiles(settings).root,
        ...(input.now !== undefined ? { now: input.now } : defaults.now !== undefined ? { now: defaults.now } : {}),
      })
    },
    doctor(input: AgentExtensionsOptions = {}) {
      return doctor({ ...defaults, ...input })
    },
  }
}

export function parseHarnessTargets(input: string | undefined) {
  return targetList(input?.split(",").map((item) => item.trim()).filter(Boolean))
}
