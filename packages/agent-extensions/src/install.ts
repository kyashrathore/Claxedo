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
import { parsePackageSource, safeRelativePath, sameSource, type PackageInstallSource } from "./source"
import {
  adoptMaterializedOwner,
  readMaterializedRuntimeRecord,
  type MaterializedExtensionPackage,
} from "./materialization"
import {
  readDesiredExtensionState,
  writeDesiredExtensionState,
  type DesiredExtensionInstall,
  type DesiredExtensionState,
} from "./state"
import { readExtensionLock, writeExtensionLock, type ExtensionLock } from "./lock"
import { verifyPackageIntegrity } from "./integrity"
import { withAgentExtensionStateLock } from "./fs-safe"
import { grantProjectExtensionTrust } from "./trust"

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
  /**
   * Optional install source for the id being addressed. Supplied by callers
   * that know it (the marketplace routes read it off the catalog entry) so a
   * record persisted under a legacy manifest-derived id still resolves when
   * addressed by its curated id. See `resolveInstallId`.
   */
  source?: PackageInstallSource
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

// Marketplace manifests carry no single package name; prefer the manifest's
// own name, then the source repo, before falling back to the cache directory
// basename (which is the resolved SHA for repo-root GitHub installs).
// Exported so the workspace-scope resolver derives the identical name:
// `package_name` builds the on-disk artifact paths, so one source must name
// the same artifacts at every scope.
export function marketplacePackageName(input: {
  manifest: Record<string, unknown>
  source: PackageInstallSource
  packageRoot: string
}) {
  if (typeof input.manifest.name === "string" && input.manifest.name.trim()) return input.manifest.name.trim()
  if (input.source.type === "github" && input.source.repo) return input.source.repo
  return path.basename(input.packageRoot)
}

/**
 * Find a record for the same source stored under a different id.
 *
 * The install id used to be derived from the fetched package's own manifest
 * name / directory basename, so a catalog entry whose upstream directory is
 * named differently than its curated id persisted under the upstream name:
 * `anthropic-skill-pdf` (…/skills/pdf) landed as `pdf`, `mcp-filesystem` as
 * `filesystem`, `mcp-fetch` as `fetch`. Installs are pinned to the catalog id
 * now, which leaves those records sitting beside the pinned ones.
 *
 * Two records of one source in one scope are never two installs: every
 * component path is built from `package_name`, so they resolve to the same
 * files and the second one can only lose the ownership check. Matching on the
 * source is therefore exact — no catalog lookup, no name heuristics.
 */
function legacyInstallId(input: {
  installs: Pick<DesiredExtensionInstall, "id" | "source">[]
  id: string
  source: PackageInstallSource
}) {
  return input.installs.find((item) => item.id !== input.id && sameSource(item.source, input.source))?.id
}

/**
 * Resolve the id a lifecycle command should act on. An exact record always
 * wins; otherwise, when the caller knows the source, a legacy record for that
 * same source answers to the curated id too. Falls back to the requested id so
 * "not found" stays the caller's own no-op/404 to report.
 */
function resolveInstallId(input: {
  installs: Pick<DesiredExtensionInstall, "id" | "source">[]
  lock?: ExtensionLock["packages"]
  id: string
  source?: PackageInstallSource
}) {
  if (input.installs.some((item) => item.id === input.id)) return input.id
  if (input.lock?.[input.id]) return input.id
  if (!input.source) return input.id
  const source = input.source
  return legacyInstallId({ installs: input.installs, id: input.id, source })
    ?? Object.entries(input.lock ?? {}).find(([id, locked]) => id !== input.id && sameSource(locked.source, source))?.[0]
    ?? input.id
}

export async function installFetchedAgentExtension(input: InstallFetchedAgentExtensionInput) {
  const packageRoot = input.packageRoot
  const packageType = await discoverAgentExtensionPackage(packageRoot)
  const packageName = packageType.type === "marketplace"
    ? marketplacePackageName({ manifest: packageType.manifest, source: input.source, packageRoot })
    : packageType.name
  const id = input.id ?? packageName
  const targets = input.targets ?? allAgentExtensionTargets()
  const files = filesFor(input)
  // Lifecycle commands and runtime replay both read-modify-write the same
  // state files; serialize the whole transaction against concurrent holders
  // (another CLI process, applyRuntimeAgentExtensions) or updates get lost.
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, lock] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readExtensionLock(files.lock),
    ])
    // Absorb a same-source record filed under a different id rather than
    // writing a second one beside it. This has to happen inside the lock and
    // before materializing: the ownership ledger is re-keyed below, and the
    // snapshot reads it back off disk as its `previous`.
    const legacyId = legacyInstallId({ installs: desired.installs, id, source: input.source })
    const existing = desired.installs.find((item) => item.id === id)
      ?? desired.installs.find((item) => item.id === legacyId)
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
    if (legacyId) await adoptMaterializedOwner(files.materialized, legacyId, id)
    const checksum = input.checksum ?? await digestDirectory(packageRoot)
    const timestamp = input.now ?? Date.now()
    const state = upsertInstallState({
      state: desired,
      id,
      ...(legacyId ? { replaces: legacyId } : {}),
      packageName,
      source: input.source,
      scope: input.scope,
      targets,
      enabled: existing?.enabled ?? true,
      installedAt: input.installedAt ?? existing?.installed_at ?? timestamp,
      updatedAt: timestamp,
    })
    const { ...lockedPackages } = lock.packages
    if (legacyId) delete lockedPackages[legacyId]
    const nextLock: ExtensionLock = {
      version: 1,
      packages: {
        ...lockedPackages,
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
      dataRoot: input.dataRoot,
      scope: input.scope,
      grantIds: [id],
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
  })
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
  // Read a legacy same-source record, but reinstall under the *requested* id:
  // installFetchedAgentExtension absorbs the legacy record, so updating by the
  // curated id is also what normalizes the record onto it.
  const desiredInstall = desired.installs.find((item) => item.id === resolveInstallId({
    installs: desired.installs,
    id: input.id,
    ...(input.source ? { source: input.source } : {}),
  }))
  if (!desiredInstall) return undefined
  if (desiredInstall.source.type === "project") {
    if (!input.projectDir) throw new Error("projectDir is required to update a project Agent Extension")
    // package_path comes from persisted (possibly repo-shipped) state;
    // validate it as a contained relative path before joining it.
    const safePackagePath = safeRelativePath(desiredInstall.source.package_path, "Agent Extension package path")
    const packageRoot = path.join(input.projectDir, safePackagePath)
    const checksum = await digestDirectory(packageRoot)
    const cache = await copyPackageToCache({
      sourceRoot: input.projectDir,
      packagePath: safePackagePath,
      resolvedSha: checksum,
      dataRoot: dataRootFor(input),
    })
    return installFetchedAgentExtension({
      source: desiredInstall.source,
      resolvedSha: checksum,
      packagePath: safePackagePath,
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
      // Forward the whole lock entry, not just the SHA: the materializer
      // verifies the package tree against the pinned digest and source before
      // writing anything, and it can only do that with the full entry.
      ...(locked ? { lock: locked } : {}),
      status: input.materialized?.packages[desired.id]?.status,
    }
  })
}

// Runs before installed.json/lock.json are written so a package that fails
// verification leaves the recorded state exactly as it was. The materializer
// re-checks the same thing immediately before it writes to disk; this is the
// earlier, cheaper failure, not the authoritative one.
async function verifyPackageRoots(input: {
  state: DesiredExtensionState
  lock: ExtensionLock
  packageRoots?: Record<string, string>
}) {
  await Promise.all(Object.entries(input.packageRoots ?? {}).map(async ([id, packageRoot]) => {
    const desired = input.state.installs.find((item) => item.id === id)
    if (desired?.enabled === false) return
    await verifyPackageIntegrity({
      id,
      ...(desired?.source ? { source: desired.source } : {}),
      ...(input.lock.packages[id] ? { lock: input.lock.packages[id] } : {}),
      packageRoot,
    })
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
  dataRoot: string
  scope: MaterializedAgentExtensionScope
  /** Install ids this operation consented to; other declared rows stay untrusted. */
  grantIds: string[]
  /** Install ids whose recorded grants are withdrawn (uninstall). */
  ungrantIds?: string[]
}) {
  await verifyPackageRoots({ state: input.state, lock: input.lock, packageRoots: input.packageRoots })
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
  // A successful explicit lifecycle write IS the user's consent — for the ids
  // they named, never for the rest of the checkout's declaration. Granting
  // only after the projection succeeded keeps a failed install from recording
  // trust for state that was never applied; the grant is what later lets
  // config-apply snapshots honor the repo-controlled rows (see ./trust).
  if (input.scope === "project" && (input.grantIds.length > 0 || (input.ungrantIds?.length ?? 0) > 0)) {
    await grantProjectExtensionTrust({
      dataRoot: input.dataRoot,
      projectDir: input.projectDir,
      ...(input.grantIds.length > 0 ? { installIds: input.grantIds } : {}),
      ...(input.ungrantIds?.length ? { removeIds: input.ungrantIds } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    })
  }
}

function upsertInstallState(input: {
  state: DesiredExtensionState
  id: string
  /** Legacy same-source record being absorbed; dropped alongside the upsert. */
  replaces?: string
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
      ...input.state.installs.filter((item) => item.id !== input.id && item.id !== input.replaces),
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
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, lock, record] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readExtensionLock(files.lock),
      readMaterializedRuntimeRecord(files.materialized),
    ])
    const id = resolveInstallId({
      installs: desired.installs,
      lock: lock.packages,
      id: input.id,
      ...(input.source ? { source: input.source } : {}),
    })
    const item = record.packages[id]
    const desiredInstall = desired.installs.find((install) => install.id === id)
    if (!item && !desiredInstall) return undefined
    const state = setEnabled({
      state: desired,
      id,
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
      dataRoot: dataRootFor(input),
      scope: input.scope,
      grantIds: [id],
    })
    const materialized = (await readMaterializedRuntimeRecord(files.materialized)).packages[id]
    if (!materialized) throw new Error(`Agent Extension ${id} was not materialized`)
    return {
      id,
      materialized,
    }
  })
}

export async function enableAgentExtension(input: AgentExtensionLifecycleInput) {
  if (!input.homeDir) throw new Error("homeDir is required to enable an Agent Extension")
  const files = filesFor(input)
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, lock] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readExtensionLock(files.lock),
    ])
    const id = resolveInstallId({
      installs: desired.installs,
      lock: lock.packages,
      id: input.id,
      ...(input.source ? { source: input.source } : {}),
    })
    const desiredInstall = desired.installs.find((item) => item.id === id)
    const locked = lock.packages[id]
    if (!desiredInstall || !locked) return undefined
    const packageRoot = cachePackageRoot({
      resolvedSha: locked.resolved_sha,
      ...(locked.package_path ? { packagePath: locked.package_path } : {}),
      dataRoot: dataRootFor(input),
    })
    await applyProjection({
      state: setEnabled({
        state: desired,
        id,
        enabled: true,
        updatedAt: input.now ?? Date.now(),
      }),
      lock,
      files,
      projectDir: projectDirFor(input),
      homeDir: input.homeDir,
      now: input.now,
      packageRoots: { [id]: packageRoot },
      dataRoot: dataRootFor(input),
      scope: input.scope,
      grantIds: [id],
    })
    const materialized = (await readMaterializedRuntimeRecord(files.materialized)).packages[id]
    if (!materialized) throw new Error(`Agent Extension ${id} was not materialized`)
    return {
      id,
      materialized,
    }
  })
}

export async function uninstallAgentExtension(input: AgentExtensionLifecycleInput) {
  const files = filesFor(input)
  return withAgentExtensionStateLock(files.root, async () => {
    const [desired, record, lock] = await Promise.all([
      readDesiredExtensionState(files.installed),
      readMaterializedRuntimeRecord(files.materialized),
      readExtensionLock(files.lock),
    ])
    const id = resolveInstallId({
      installs: desired.installs,
      lock: lock.packages,
      id: input.id,
      ...(input.source ? { source: input.source } : {}),
    })
    const item = record.packages[id]
    const desiredInstall = desired.installs.find((install) => install.id === id)
    const lockedPackage = lock.packages[id]
    if (!item && !desiredInstall && !lockedPackage) return undefined
    const { [id]: _removedLock, ...locked } = lock.packages
    await applyProjection({
      state: {
        version: 1,
        installs: desired.installs.filter((install) => install.id !== id),
      },
      lock: { version: 1, packages: locked },
      files,
      projectDir: projectDirFor(input),
      homeDir: input.homeDir,
      now: input.now,
      dataRoot: dataRootFor(input),
      scope: input.scope,
      // Removing a package consents to nothing — and WITHDRAWS the consent
      // it had: a checkout that later restores the exact same bytes from git
      // history must not resurrect the install on the strength of the old
      // grant.
      grantIds: [],
      ungrantIds: [id],
    })
    return item ?? {
      package_name: desiredInstall?.package_name ?? id,
      source: desiredInstall?.source ?? lockedPackage!.source,
      resolved_sha: lockedPackage?.resolved_sha ?? "",
      enabled: false,
      targets: desiredInstall?.targets ?? lockedPackage?.targets ?? [],
      components: [],
      materialized_at: input.now ?? Date.now(),
      status: "disabled" as const,
    }
  })
}
