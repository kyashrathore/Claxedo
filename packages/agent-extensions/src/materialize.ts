import fs from "fs/promises"
import path from "path"
import { discoverAgentExtensionComponents, type DiscoveredAgentExtensionComponent } from "./discovery"
import { materializeCursorLocalPlugin } from "./materializers/cursor"
import {
  materializeStandaloneMcp,
  normalizeStandaloneMcpConfig,
  removeStandaloneMcpEntries,
  type StandaloneMcpConfig,
} from "./materializers/mcp"
import { materializeStandaloneSkill } from "./materializers/skills"
import {
  materializedComponentKey as componentKey,
  readMaterializedRuntimeRecord,
  writeMaterializedRuntimeRecord,
  type MaterializedComponent,
  type MaterializedExtensionPackage,
  type MaterializedRuntimeRecord,
} from "./materialization"
import { isHarnessTarget, type MaterializedAgentExtensionScope, type PackageSource, type HarnessTarget } from "./types"
import { samePackageSourceIdentity, verifyPackageIntegrity, type PackageIntegrityLock } from "./integrity"

export type AgentExtensionMaterializationInstall = {
  desired: {
    id: string
    package_name?: string
    source: PackageSource
    scope?: string
    enabled?: boolean
    targets?: unknown[]
  }
  lock?: PackageIntegrityLock
  status?: string
}

export type AgentExtensionMaterializeOptions = {
  installs: AgentExtensionMaterializationInstall[]
  packageRoots: Record<string, string>
  projectDir: string
  stateRoot: string
  homeDir: string
  now?: number | (() => number)
  replaceOwned?: boolean
}

function sorted<T>(input: Record<string, T>) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) as Record<string, T>
}

function now(input: AgentExtensionMaterializeOptions) {
  return typeof input.now === "function" ? input.now() : input.now ?? Date.now()
}

function scope(input: AgentExtensionMaterializationInstall): MaterializedAgentExtensionScope {
  return input.desired.scope === "machine" ? "machine" : "project"
}

function targets(input: AgentExtensionMaterializationInstall): HarnessTarget[] {
  return (input.desired.targets ?? []).filter(isHarnessTarget)
}

function packageName(input: AgentExtensionMaterializationInstall, packageRoot: string) {
  return input.desired.package_name ?? input.desired.id ?? path.basename(packageRoot)
}

function packageNameWithoutRoot(input: AgentExtensionMaterializationInstall) {
  return input.desired.package_name ?? input.desired.id
}

function status(components: MaterializedComponent[], fallback: string | undefined): MaterializedExtensionPackage["status"] {
  if (components.length === 0) return fallback === "failed" || fallback === "drifted" ? fallback : "partial"
  if (components.every((item) => item.status === "skipped")) return "partial"
  if (components.some((item) => item.status === "failed")) return "failed"
  if (components.some((item) => item.status === "drifted")) return "drifted"
  if (components.some((item) => item.status === "skipped")) return "partial"
  return "applied"
}

async function readJson(file: string) {
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>
}

const CLAXEDO_MCP_MANAGED_ENV = new Set([
  "CLAXEDO_SERVER_URL",
  "OPENCODE_API_URL",
  "OPENCODE_API_DIR",
  "CLAXEDO_WORKSPACE_ID",
])

const CLAXEDO_MCP_AUTH_ENV = new Set([
  "CLAXEDO_LOCAL_TOKEN",
  "CLAXEDO_JIT_TOKEN",
  "CLAXEDO_BROKER_TOKEN",
  "CLAXEDO_MCP_BROKER_TOKEN",
  "CLAXEDO_AUTH_TOKEN",
  "CLAXEDO_API_TOKEN",
])

function textEnv(name: string) {
  const value = process.env[name]?.trim()
  return value || undefined
}

function claxedoMcpServerUrl() {
  return textEnv("CLAXEDO_SERVER_URL") ?? "http://127.0.0.1:3001"
}

function claxedoMcpWorkspaceId() {
  return textEnv("CLAXEDO_WORKSPACE_ID") ?? textEnv("CLAXEDO_WR_WORKSPACE_ID")
}

// Special case: the first-party Claxedo MCP package (claxedo-mcp installed
// from kyashrathore/Claxedo@dev) gets its connection env rewritten from the
// materializing process's environment, and any CLAXEDO_* auth tokens in the
// package config are stripped so credentials never land in target files.
// This applies ONLY to that exact id+source; third-party packages are
// materialized verbatim.
//
// The privilege keys off the source tuple, so it must key off the *pinned*
// tuple rather than the one the desired state claims: require the lock to
// carry a matching source. A package whose lock does not pin that exact source
// is materialized verbatim like any third party, which is the safe default.
function isFirstPartyClaxedoMcpInstall(input: AgentExtensionMaterializationInstall) {
  const source = input.desired.source
  if (!input.lock?.source || !samePackageSourceIdentity(source, input.lock.source)) return false
  return input.desired.id === "claxedo-mcp"
    && source.type === "github"
    && source.owner === "kyashrathore"
    && source.repo?.toLowerCase() === "claxedo"
    && source.ref === "dev"
    && source.package_path === "packages/claxedo-mcp"
}

function managedClaxedoMcpEnv(input: {
  env?: Record<string, string>
  projectDir: string
  targetScope: MaterializedAgentExtensionScope
}) {
  return {
    ...Object.fromEntries(Object.entries(input.env ?? {}).filter(([key, value]) =>
      typeof value === "string"
      && !CLAXEDO_MCP_MANAGED_ENV.has(key)
      && !CLAXEDO_MCP_AUTH_ENV.has(key)
    )),
    CLAXEDO_SERVER_URL: claxedoMcpServerUrl(),
    ...(input.targetScope === "project" ? { OPENCODE_API_DIR: input.projectDir } : {}),
    ...(claxedoMcpWorkspaceId() ? { CLAXEDO_WORKSPACE_ID: claxedoMcpWorkspaceId() } : {}),
  }
}

function managedClaxedoMcpConfig(input: {
  config: StandaloneMcpConfig
  projectDir: string
  targetScope: MaterializedAgentExtensionScope
}) {
  return {
    servers: sorted(Object.fromEntries(Object.entries(input.config.servers).map(([name, config]) => {
      if (name !== "claxedo" || !("command" in config)) return [name, config]
      return [name, {
        ...config,
        env: managedClaxedoMcpEnv({
          env: config.env,
          projectDir: input.projectDir,
          targetScope: input.targetScope,
        }),
      }]
    }))),
  }
}

async function removeTreeOrLink(target: string) {
  const stat = await fs.lstat(target).catch(() => undefined)
  if (!stat) return
  if (stat.isSymbolicLink()) {
    // Remove the LINK, never the tree behind it. A directory symlink needs
    // rmdir on Windows (unlink refuses it) and unlink on POSIX (rmdir
    // refuses it); bun's fs.rm EFAULTs outright on the Windows case, so
    // pick the primitive instead of delegating.
    await fs.unlink(target).catch(async () => {
      await fs.rmdir(target)
    })
    return
  }
  await fs.rm(target, { recursive: stat.isDirectory(), force: true })
}

async function removeMaterializedComponent(component: MaterializedComponent) {
  if (component.status !== "applied" || !component.path) return
  if (component.type !== "mcp") {
    await removeTreeOrLink(component.path)
    return
  }
  await removeStandaloneMcpEntries({ file: component.path, names: [component.component] })
}

// Removes only what the package owns: whole trees/links for skills and
// plugins, but individual entries for MCP components — their recorded path is
// a shared config file (.mcp.json, ~/.claude.json) that must never be rm'd
// wholesale.
export async function uninstallOwnedComponents(input: {
  record: MaterializedRuntimeRecord
  ownerId: string
}) {
  await Promise.all((input.record.packages[input.ownerId]?.components ?? [])
    .map((item) => removeMaterializedComponent(item)))
}

export async function removeStaleMaterializedComponents(previous: MaterializedRuntimeRecord, next: MaterializedRuntimeRecord) {
  const nextComponents = new Set(Object.values(next.packages).flatMap((pkg) =>
    pkg.components.flatMap((component) =>
      component.path ? [`${component.type}\n${component.path}\n${component.component}`] : [],
    ),
  ))
  await Promise.all(Object.values(previous.packages).flatMap((pkg) =>
    pkg.components.flatMap((component) =>
      component.status === "applied"
      && component.path
      && !nextComponents.has(`${component.type}\n${component.path}\n${component.component}`)
        ? [removeMaterializedComponent(component)]
        : [],
    ),
  ))
}

async function materializeDiscoveredComponent(input: {
  component: DiscoveredAgentExtensionComponent
  install: AgentExtensionMaterializationInstall
  runner: HarnessTarget
  packageRoot: string
  packageName: string
  targetScope: MaterializedAgentExtensionScope
  ownerId: string
  projectDir: string
  homeDir: string
  previous: MaterializedRuntimeRecord
  replaceOwned?: boolean
}) {
  if (input.component.type === "skill") {
    return [await materializeStandaloneSkill({
      skillDir: input.component.path,
      name: path.resolve(input.component.path) === path.resolve(input.packageRoot) ? input.packageName : input.component.name,
      runner: input.runner,
      scope: input.targetScope,
      ownerId: input.ownerId,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      record: input.previous,
      replaceOwned: input.replaceOwned,
    })]
  }
  if (input.component.type === "plugin") {
    if (input.runner === input.component.runner) {
      return [await materializeCursorLocalPlugin({
        packageDir: input.component.path,
        pluginName: input.component.name,
        ownerId: input.ownerId,
        homeDir: input.install.desired.scope === "workspace" ? input.projectDir : input.homeDir,
        record: input.previous,
        replaceOwned: input.replaceOwned,
      })]
    }
    return [{
      runner: input.runner,
      component: input.component.name,
      type: "plugin" as const,
      status: "skipped" as const,
      reason: "native plugin install path not verified",
    }]
  }
  if (input.component.type === "mcp") {
    const mcpConfig = normalizeStandaloneMcpConfig(await readJson(input.component.path))
    return await materializeStandaloneMcp({
      config: isFirstPartyClaxedoMcpInstall(input.install)
        ? managedClaxedoMcpConfig({ config: mcpConfig, projectDir: input.projectDir, targetScope: input.targetScope })
        : mcpConfig,
      runner: input.runner,
      scope: input.targetScope,
      ownerId: input.ownerId,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      record: input.previous,
      replaceOwned: input.replaceOwned,
    })
  }
  return [{
    runner: input.runner,
    component: input.component.name,
    type: "hook" as const,
    status: "skipped" as const,
    reason: "agent hook package materialization is not implemented yet",
  }]
}

// A component that failed mid-run must not cost the package the components it
// applied on earlier runs: keep previous applied entries that this run did not
// re-produce, so ownership survives and stale-removal does not delete them.
function withPreviousApplied(components: MaterializedComponent[], previous: MaterializedExtensionPackage | undefined) {
  const seen = new Set(components.map(componentKey))
  return [
    ...components,
    ...(previous?.components ?? []).filter((component) => component.status === "applied" && !seen.has(componentKey(component))),
  ]
}

async function materializePackage(input: {
  install: AgentExtensionMaterializationInstall
  packageRoot: string
  projectDir: string
  homeDir: string
  previous: MaterializedRuntimeRecord
  materializedAt: number
  replaceOwned?: boolean
}) {
  const name = packageName(input.install, input.packageRoot)
  const ownerId = input.install.desired.id
  const targetScope = scope(input.install)
  const components: MaterializedComponent[] = []
  const failures: unknown[] = []
  const discovered = await discoverAgentExtensionComponents(input.packageRoot)

  for (const runner of targets(input.install)) {
    if (discovered.length > 0) {
      for (const component of discovered) {
        // Desired/lock state is committed before materializers run and each
        // component may touch shared target files, so a throw here must not
        // abort the run before the record is written: components applied so
        // far would be on disk but unowned, and every retry would then
        // conflict against the package's own prior output. Record the failure
        // and keep going; the caller rethrows after persisting the record.
        try {
          components.push(...await materializeDiscoveredComponent({
            component,
            install: input.install,
            runner,
            packageRoot: input.packageRoot,
            packageName: name,
            targetScope,
            ownerId,
            projectDir: input.projectDir,
            homeDir: input.homeDir,
            previous: input.previous,
            replaceOwned: input.replaceOwned,
          }))
        } catch (err) {
          failures.push(err)
          components.push({
            runner,
            component: component.name,
            type: component.type,
            status: "failed",
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
      continue
    }
    components.push({
      runner,
      component: name,
      type: "plugin",
      status: "skipped",
      reason: "unsupported package shape",
    })
  }

  const recorded = failures.length > 0
    ? withPreviousApplied(components, input.previous.packages[ownerId])
    : components

  return {
    package: {
      package_name: name,
      source: input.install.desired.source,
      resolved_sha: input.install.lock?.resolved_sha ?? "",
      enabled: true,
      targets: targets(input.install),
      components: recorded,
      materialized_at: input.materializedAt,
      status: status(recorded, input.install.status),
    } satisfies MaterializedExtensionPackage,
    failures,
  }
}

// Every package root this run would materialize must match the content its
// lock pins, and the whole check runs BEFORE anything touches disk. Verifying
// inline per package would not be enough: a package that verified while a
// sibling failed would leave applied artifacts on disk with no ownership
// record in materialized.json, and every later run would then refuse to
// overwrite the package's own unowned output.
async function verifyMaterializationIntegrity(input: AgentExtensionMaterializeOptions) {
  await Promise.all(input.installs.map(async (install) => {
    // Disabled installs materialize nothing, so there is no content to verify.
    if (install.desired.enabled === false) return
    const packageRoot = input.packageRoots[install.desired.id]
    if (!packageRoot) return
    await verifyPackageIntegrity({
      id: install.desired.id,
      source: install.desired.source,
      ...(install.lock ? { lock: install.lock } : {}),
      packageRoot,
    })
  }))
}

export async function materializeAgentExtensionSnapshot(input: AgentExtensionMaterializeOptions) {
  await verifyMaterializationIntegrity(input)
  const materializedFile = path.join(input.stateRoot, "materialized.json")
  const previous = await readMaterializedRuntimeRecord(materializedFile)
  const materializedAt = now(input)
  const failures: unknown[] = []
  const packageEntries = (await Promise.all(input.installs
    .map(async (install) => {
      const existing = previous.packages[install.desired.id]
      if (install.desired.enabled === false) {
        return [[install.desired.id, {
          package_name: packageNameWithoutRoot(install),
          source: install.desired.source,
          resolved_sha: install.lock?.resolved_sha ?? existing?.resolved_sha ?? "",
          enabled: false,
          targets: targets(install),
          components: [],
          materialized_at: materializedAt,
          status: "disabled" as const,
        }]]
      }
      const packageRoot = input.packageRoots[install.desired.id]
      if (
        !packageRoot
        && existing
        && existing.resolved_sha === install.lock?.resolved_sha
        && JSON.stringify(existing.targets) === JSON.stringify(targets(install))
        && existing.status !== "failed"
        && existing.status !== "drifted"
      ) {
        return [[install.desired.id, existing]]
      }
      if (!packageRoot) return []
      const result = await materializePackage({
        install,
        packageRoot,
        projectDir: input.projectDir,
        homeDir: input.homeDir,
        previous,
        materializedAt,
        replaceOwned: input.replaceOwned ?? !!existing,
      })
      failures.push(...result.failures)
      return [[install.desired.id, result.package]]
    }))).flat() as Array<[string, MaterializedExtensionPackage]>
  const packages = sorted(Object.fromEntries(packageEntries) as Record<string, MaterializedExtensionPackage>)
  const next = {
    version: 1 as const,
    packages,
  }
  await removeStaleMaterializedComponents(previous, next)
  await writeMaterializedRuntimeRecord(materializedFile, next)
  // Rethrow only after the record is on disk so applied components stay owned
  // and a retry does not conflict against this run's own output.
  if (failures.length > 0) throw failures[0]
  return readMaterializedRuntimeRecord(materializedFile)
}
