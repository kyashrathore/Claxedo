import path from "path"
import {
  allHarnessTargets,
  type MaterializedAgentExtensionScope,
  type HarnessTarget,
} from "./types"
import { cachePackageRoot, copyPackageToCache, digestDirectory } from "./cache"
import { discoverAgentExtensionPackage } from "./manifest"
import { fetchGitHubPackageToCache } from "./fetch"
import { materializeAgentExtensionSnapshot, type AgentExtensionMaterializationInstall } from "./materialize"
import { materializedAgentExtensionFiles, type AgentExtensionFiles } from "./storage"
import { parsePackageSource, sameSource, type PackageInstallSource } from "./source"
import { readMaterializedRuntimeRecord, type MaterializedExtensionPackage } from "./materialization"
import {
  readDesiredExtensionState,
  writeDesiredExtensionState,
  type DesiredExtensionState,
} from "./state"
import { readExtensionLock, writeExtensionLock, type ExtensionLock } from "./lock"

export class AgentExtensionConflictError extends Error {
  constructor(
    public readonly code: "agent_extension_source_conflict",
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message)
    this.name = "AgentExtensionConflictError"
  }
}

export type InstallCachedAgentExtensionInput = {
  sourceRoot: string
  source: PackageInstallSource
  resolvedSha: string
  packagePath?: string
  scope: MaterializedAgentExtensionScope
  projectDir?: string
  dataRoot: string
  homeDir: string
  targets?: HarnessTarget[]
  id?: string
  now?: number
  installedAt?: number
  replaceOwned?: boolean
}

export type InstallFetchedAgentExtensionInput = Omit<InstallCachedAgentExtensionInput, "sourceRoot"> & {
  packageRoot: string
  checksum?: string
}

export type InstallGitHubAgentExtensionInput = Omit<InstallCachedAgentExtensionInput, "sourceRoot" | "source" | "resolvedSha" | "packagePath"> & {
  source: string
}

export type AgentExtensionLifecycleInput = {
  id: string
  scope: MaterializedAgentExtensionScope
  projectDir?: string
  dataRoot: string
  homeDir?: string
  now?: number
  fetchPackage?: typeof fetchGitHubPackageToCache
}

export type AgentExtensionLifecycleResult = {
  id: string
  materialized: MaterializedExtensionPackage
}

export function allAgentExtensionTargets(): HarnessTarget[] {
  return allHarnessTargets()
}

export async function installCachedAgentExtension(input: InstallCachedAgentExtensionInput) {
  const cache = await copyPackageToCache({
    ...input,
    dataRoot: dataRootFor(input),
  })
  return installFetchedAgentExtension({
    ...input,
    packageRoot: cache.path,
    checksum: cache.checksum,
  })
}

export async function installFetchedAgentExtension(input: InstallFetchedAgentExtensionInput) {
  const packageRoot = input.packageRoot
  const packageType = await discoverAgentExtensionPackage(packageRoot)
  const packageName = packageType.type === "marketplace" ? path.basename(packageRoot) : packageType.name
  const id = input.id ?? packageName
  const targets = input.targets ?? allAgentExtensionTargets()
  const files = filesFor(input)
  const [desired, lock] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readExtensionLock(files.lock),
  ])
  const existing = desired.installs.find((item) => item.id === id)
  if (existing && !sameSource(existing.source, input.source) && !input.replaceOwned) {
    throw new AgentExtensionConflictError(
      "agent_extension_source_conflict",
      `Agent Extension ${id} is already installed from a different source`,
      {
        id,
        existingSource: existing.source,
        requestedSource: input.source,
      },
    )
  }
  const checksum = input.checksum ?? await digestDirectory(packageRoot)
  const timestamp = input.now ?? Date.now()
  const state = upsertInstallState({
    state: desired,
    id,
    packageName,
    source: input.source,
    scope: input.scope,
    targets,
    enabled: existing?.enabled ?? true,
    installedAt: input.installedAt ?? existing?.installed_at ?? timestamp,
    updatedAt: timestamp,
  })
  const nextLock: ExtensionLock = {
    version: 1,
    packages: {
      ...lock.packages,
      [id]: {
        source: input.source,
        resolved_sha: input.resolvedSha,
        ...(input.packagePath ? { package_path: input.packagePath } : {}),
        manifest_digests: { package: checksum },
        component_digests: { package: checksum },
        targets,
      },
    },
  }
  await applyProjection({
    state,
    lock: nextLock,
    files,
    projectDir: projectDirFor(input),
    homeDir: input.homeDir,
    now: input.now,
    packageRoots: { [id]: packageRoot },
    ...(input.replaceOwned !== undefined ? { replaceOwned: input.replaceOwned } : {}),
  })
  const materialized = await readMaterializedRuntimeRecord(files.materialized)
  const nextPackage = materialized.packages[id]
  if (!nextPackage) throw new Error(`Agent Extension ${id} was not materialized`)

  return {
    id,
    package: packageType,
    cache: {
      path: packageRoot,
      checksum,
    },
    materialized: nextPackage,
  }
}

export async function installGitHubAgentExtension(input: InstallGitHubAgentExtensionInput) {
  const source = parsePackageSource(input.source)
  const cache = await fetchGitHubPackageToCache({
    source,
    dataRoot: dataRootFor(input),
  })
  return installFetchedAgentExtension({
    ...input,
    source,
    resolvedSha: cache.resolvedSha,
    ...(source.package_path ? { packagePath: source.package_path } : {}),
    packageRoot: cache.path,
    checksum: cache.checksum,
  })
}

export async function updateAgentExtension(input: AgentExtensionLifecycleInput) {
  if (!input.homeDir) throw new Error("homeDir is required to update an Agent Extension")
  const files = filesFor(input)
  const desired = await readDesiredExtensionState(files.installed)
  const desiredInstall = desired.installs.find((item) => item.id === input.id)
  if (!desiredInstall) return undefined
  if (desiredInstall.source.type === "project") {
    if (!input.projectDir) throw new Error("projectDir is required to update a project Agent Extension")
    const packageRoot = path.join(input.projectDir, desiredInstall.source.package_path)
    const checksum = await digestDirectory(packageRoot)
    const cache = await copyPackageToCache({
      sourceRoot: input.projectDir,
      packagePath: desiredInstall.source.package_path,
      resolvedSha: checksum,
      dataRoot: dataRootFor(input),
    })
    return installFetchedAgentExtension({
      source: desiredInstall.source,
      resolvedSha: checksum,
      packagePath: desiredInstall.source.package_path,
      scope: input.scope,
      projectDir: input.projectDir,
      dataRoot: dataRootFor(input),
      homeDir: input.homeDir,
      targets: desiredInstall.targets,
      id: input.id,
      now: input.now,
      installedAt: desiredInstall.installed_at,
      replaceOwned: true,
      packageRoot: cache.path,
      checksum: cache.checksum,
    })
  }
  const cache = await (input.fetchPackage ?? fetchGitHubPackageToCache)({
    source: desiredInstall.source,
    dataRoot: dataRootFor(input),
  })
  return installFetchedAgentExtension({
    source: desiredInstall.source,
    resolvedSha: cache.resolvedSha,
    ...(desiredInstall.source.package_path ? { packagePath: desiredInstall.source.package_path } : {}),
    scope: input.scope,
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
    dataRoot: dataRootFor(input),
    homeDir: input.homeDir,
    targets: desiredInstall.targets,
    id: input.id,
    now: input.now,
    installedAt: desiredInstall.installed_at,
    replaceOwned: true,
    packageRoot: cache.path,
    checksum: cache.checksum,
  })
}

function projectDirFor(input: AgentExtensionLifecycleInput | InstallFetchedAgentExtensionInput) {
  return input.projectDir ?? input.homeDir ?? process.cwd()
}

function dataRootFor(input: { dataRoot: string }) {
  return input.dataRoot
}

function filesFor(input: {
  scope: MaterializedAgentExtensionScope
  projectDir?: string
  dataRoot: string
}) {
  return materializedAgentExtensionFiles({
    ...input,
    dataRoot: dataRootFor(input),
  })
}

function materializationInstalls(input: {
  desired: DesiredExtensionState
  lock: ExtensionLock
  materialized?: Awaited<ReturnType<typeof readMaterializedRuntimeRecord>>
}): AgentExtensionMaterializationInstall[] {
  return input.desired.installs.map((desired) => {
    const locked = input.lock.packages[desired.id]
    return {
      desired: {
        id: desired.id,
        package_name: desired.package_name,
        source: desired.source,
        scope: desired.scope,
        enabled: desired.enabled,
        targets: desired.targets,
      },
      ...(locked ? { lock: { resolved_sha: locked.resolved_sha } } : {}),
      status: input.materialized?.packages[desired.id]?.status,
    }
  })
}

function expectedPackageDigest(input: ExtensionLock["packages"][string] | undefined) {
  return input?.component_digests.package ?? input?.manifest_digests.package
}

async function verifyPackageRoots(input: {
  lock: ExtensionLock
  packageRoots?: Record<string, string>
}) {
  await Promise.all(Object.entries(input.packageRoots ?? {}).map(async ([id, packageRoot]) => {
    const expected = expectedPackageDigest(input.lock.packages[id])
    if (!expected) return
    if (await digestDirectory(packageRoot) !== expected) throw new Error(`Agent Extension ${id} cache checksum mismatch`)
  }))
}

async function applyProjection(input: {
  state: DesiredExtensionState
  lock: ExtensionLock
  files: AgentExtensionFiles
  projectDir: string
  homeDir?: string
  now?: number
  packageRoots?: Record<string, string>
  replaceOwned?: boolean
}) {
  await verifyPackageRoots({ lock: input.lock, packageRoots: input.packageRoots })
  await Promise.all([
    writeDesiredExtensionState(input.files.installed, input.state),
    writeExtensionLock(input.files.lock, input.lock),
  ])
  await materializeAgentExtensionSnapshot({
    installs: materializationInstalls({ desired: input.state, lock: input.lock }),
    packageRoots: input.packageRoots ?? {},
    projectDir: input.projectDir,
    stateRoot: input.files.root,
    homeDir: input.homeDir ?? input.projectDir,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.replaceOwned !== undefined ? { replaceOwned: input.replaceOwned } : {}),
  })
}

function upsertInstallState(input: {
  state: DesiredExtensionState
  id: string
  packageName: string
  source: PackageInstallSource
  scope: MaterializedAgentExtensionScope
  targets: HarnessTarget[]
  enabled: boolean
  installedAt: number
  updatedAt: number
}) {
  return {
    version: 1 as const,
    installs: [
      ...input.state.installs.filter((item) => item.id !== input.id),
      {
        id: input.id,
        package_name: input.packageName,
        source: input.source,
        scope: input.scope,
        enabled: input.enabled,
        targets: input.targets,
        installed_at: input.installedAt,
        updated_at: input.updatedAt,
      },
    ],
  }
}

function setEnabled(input: {
  state: DesiredExtensionState
  id: string
  enabled: boolean
  updatedAt: number
}) {
  return {
    version: 1 as const,
    installs: input.state.installs.map((item) => item.id === input.id
      ? { ...item, enabled: input.enabled, updated_at: input.updatedAt }
      : item),
  }
}

export async function disableAgentExtension(input: AgentExtensionLifecycleInput) {
  const files = filesFor(input)
  const [desired, lock, record] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readExtensionLock(files.lock),
    readMaterializedRuntimeRecord(files.materialized),
  ])
  const item = record.packages[input.id]
  const desiredInstall = desired.installs.find((install) => install.id === input.id)
  if (!item && !desiredInstall) return undefined
  const state = setEnabled({
    state: desired,
    id: input.id,
    enabled: false,
    updatedAt: input.now ?? Date.now(),
  })
  await applyProjection({
    state,
    lock,
    files,
    projectDir: projectDirFor(input),
    homeDir: input.homeDir,
    now: input.now,
  })
  const materialized = (await readMaterializedRuntimeRecord(files.materialized)).packages[input.id]
  if (!materialized) throw new Error(`Agent Extension ${input.id} was not materialized`)
  return {
    id: input.id,
    materialized,
  }
}

export async function enableAgentExtension(input: AgentExtensionLifecycleInput) {
  if (!input.homeDir) throw new Error("homeDir is required to enable an Agent Extension")
  const files = filesFor(input)
  const [desired, lock] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readExtensionLock(files.lock),
  ])
  const desiredInstall = desired.installs.find((item) => item.id === input.id)
  const locked = lock.packages[input.id]
  if (!desiredInstall || !locked) return undefined
  const packageRoot = cachePackageRoot({
    resolvedSha: locked.resolved_sha,
    ...(locked.package_path ? { packagePath: locked.package_path } : {}),
    dataRoot: dataRootFor(input),
  })
  await applyProjection({
    state: setEnabled({
      state: desired,
      id: input.id,
      enabled: true,
      updatedAt: input.now ?? Date.now(),
    }),
    lock,
    files,
    projectDir: projectDirFor(input),
    homeDir: input.homeDir,
    now: input.now,
    packageRoots: { [input.id]: packageRoot },
  })
  const materialized = (await readMaterializedRuntimeRecord(files.materialized)).packages[input.id]
  if (!materialized) throw new Error(`Agent Extension ${input.id} was not materialized`)
  return {
    id: input.id,
    materialized,
  }
}

export async function uninstallAgentExtension(input: AgentExtensionLifecycleInput) {
  const files = filesFor(input)
  const [desired, record, lock] = await Promise.all([
    readDesiredExtensionState(files.installed),
    readMaterializedRuntimeRecord(files.materialized),
    readExtensionLock(files.lock),
  ])
  const item = record.packages[input.id]
  const desiredInstall = desired.installs.find((install) => install.id === input.id)
  const lockedPackage = lock.packages[input.id]
  if (!item && !desiredInstall && !lockedPackage) return undefined
  const { [input.id]: _removedLock, ...locked } = lock.packages
  await applyProjection({
    state: {
      version: 1,
      installs: desired.installs.filter((install) => install.id !== input.id),
    },
    lock: { version: 1, packages: locked },
    files,
    projectDir: projectDirFor(input),
    homeDir: input.homeDir,
    now: input.now,
  })
  return item ?? {
    package_name: desiredInstall?.package_name ?? input.id,
    source: desiredInstall?.source ?? lockedPackage!.source,
    resolved_sha: lockedPackage?.resolved_sha ?? "",
    enabled: false,
    targets: desiredInstall?.targets ?? lockedPackage?.targets ?? [],
    components: [],
    materialized_at: input.now ?? Date.now(),
    status: "disabled" as const,
  }
}
