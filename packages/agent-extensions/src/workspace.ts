import {
  isHarnessTarget,
  type HarnessTarget,
} from "./types"
import { digestDirectory } from "./cache"
import { discoverAgentExtensionPackage } from "./manifest"
import { fetchGitHubPackageToCache } from "./fetch"
import { parsePackageSource } from "./source"
import {
  readDesiredExtensionState,
  removeDesiredExtensionInstall,
  setDesiredExtensionEnabled,
  writeDesiredExtensionState,
  type DesiredExtensionInstall,
} from "./state"
import { readExtensionLock, writeExtensionLock, type LockedExtensionPackage } from "./lock"
import { workspaceAgentExtensionFiles } from "./storage"
import { allAgentExtensionTargets, marketplacePackageName } from "./install"

export type WorkspaceAgentExtensionRecord = {
  desired: DesiredExtensionInstall
  lock?: LockedExtensionPackage
}

function object(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function desiredInstall(input: unknown) {
  const row = object(input)
  if (!row) return
  if (typeof row.id !== "string") return
  if (typeof row.package_name !== "string") return
  if (row.scope !== "workspace") return
  if (typeof row.enabled !== "boolean") return
  if (!object(row.source)) return
  if (!Array.isArray(row.targets)) return
  if (!row.targets.every(isHarnessTarget)) return
  if (typeof row.installed_at !== "number") return
  if (typeof row.updated_at !== "number") return
  return row as DesiredExtensionInstall
}

function lockedPackage(input: unknown) {
  const row = object(input)
  if (!row) return
  if (typeof row.resolved_sha !== "string") return
  if (!object(row.source)) return
  if (!object(row.manifest_digests)) return
  if (!object(row.component_digests)) return
  if (!Array.isArray(row.targets)) return
  if (!row.targets.every(isHarnessTarget)) return
  return row as LockedExtensionPackage
}

function dataRootFor(input: { dataRoot: string }) {
  return input.dataRoot
}

function filesFor(input: {
  workspaceId: string
  dataRoot: string
}) {
  return workspaceAgentExtensionFiles({
    ...input,
    dataRoot: dataRootFor(input),
  })
}

export function workspaceAgentExtensionRecords(input: unknown): WorkspaceAgentExtensionRecord[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item) => {
    const row = object(item)
    const desired = desiredInstall(row?.desired)
    if (!desired) return []
    const lock = lockedPackage(row?.lock)
    return [{
      desired,
      ...(lock ? { lock } : {}),
    }]
  })
}

export async function resolveGitHubWorkspaceAgentExtension(input: {
  source: string
  workspaceId: string
  id?: string
  dataRoot: string
  targets?: HarnessTarget[]
  now?: number
  fetchPackage?: typeof fetchGitHubPackageToCache
}) {
  const source = parsePackageSource(input.source)
  if (source.type !== "github") throw new Error("Only GitHub workspace Agent Extension sources are supported")
  const cache = await (input.fetchPackage ?? fetchGitHubPackageToCache)({
    source,
    dataRoot: dataRootFor(input),
  })
  const packageType = await discoverAgentExtensionPackage(cache.path)
  // Same derivation as installFetchedAgentExtension: deriving from the install
  // id here used to give one source a different `package_name` per scope, so
  // the scopes materialized the same package to different artifact paths.
  const packageName = packageType.type === "marketplace"
    ? marketplacePackageName({ manifest: packageType.manifest, source, packageRoot: cache.path })
    : packageType.name
  const targets = input.targets ?? allAgentExtensionTargets()
  const checksum = await digestDirectory(cache.path)
  return {
    id: input.id ?? packageName,
    package: packageType,
    cache,
    record: {
      desired: {
        id: input.id ?? packageName,
        package_name: packageName,
        source,
        scope: "workspace" as const,
        enabled: true,
        targets,
        installed_at: input.now ?? Date.now(),
        updated_at: input.now ?? Date.now(),
      },
      lock: {
        source,
        resolved_sha: cache.resolvedSha,
        ...(source.package_path ? { package_path: source.package_path } : {}),
        manifest_digests: { package: checksum },
        component_digests: { package: checksum },
        targets,
      },
    },
  }
}

export async function mirrorWorkspaceAgentExtensionRecord(input: {
  workspaceId: string
  dataRoot: string
  record: WorkspaceAgentExtensionRecord & { lock: LockedExtensionPackage }
  /**
   * Legacy same-source id being absorbed by this record; its install and lock
   * rows are dropped in the same write so the mirror never holds two records
   * of one source (see `legacyInstallId` in install.ts for the rationale).
   */
  replaces?: string
}) {
  const files = filesFor(input)
  const [desired, lock] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readExtensionLock(files.lock),
  ])
  const packages = { ...lock.packages }
  if (input.replaces) delete packages[input.replaces]
  await Promise.all([
    writeDesiredExtensionState(files.installed, {
      version: 1,
      installs: [
        ...desired.installs.filter((item) => item.id !== input.record.desired.id && item.id !== input.replaces),
        input.record.desired,
      ],
    }),
    writeExtensionLock(files.lock, {
      version: 1,
      packages: {
        ...packages,
        [input.record.desired.id]: input.record.lock,
      },
    }),
  ])
}

export async function readMirroredWorkspaceAgentExtensions(input: {
  workspaceId: string
  dataRoot: string
}) {
  const files = filesFor(input)
  const [desired, lock] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readExtensionLock(files.lock),
  ])
  return desired.installs.map((item) => ({
    desired: item,
    ...(lock.packages[item.id] ? { lock: lock.packages[item.id] } : {}),
  }))
}

export async function setMirroredWorkspaceAgentExtensionEnabled(input: {
  workspaceId: string
  id: string
  enabled: boolean
  dataRoot: string
  now?: number
}) {
  await setDesiredExtensionEnabled(filesFor(input).installed, input.id, input.enabled, input.now ?? Date.now())
}

export async function removeMirroredWorkspaceAgentExtension(input: {
  workspaceId: string
  id: string
  dataRoot: string
}) {
  const files = filesFor(input)
  const lock = await readExtensionLock(files.lock)
  const { [input.id]: _removed, ...packages } = lock.packages
  await Promise.all([
    removeDesiredExtensionInstall(files.installed, input.id),
    writeExtensionLock(files.lock, { version: 1, packages }),
  ])
}
