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
  readMaterializedRuntimeRecord,
  writeMaterializedRuntimeRecord,
  type MaterializedComponent,
  type MaterializedExtensionPackage,
  type MaterializedRuntimeRecord,
} from "./materialization"
import { isHarnessTarget, type MaterializedAgentExtensionScope, type PackageSource, type HarnessTarget } from "./types"

export type AgentExtensionMaterializationInstall = {
  desired: {
    id: string
    package_name?: string
    source: PackageSource
    scope?: string
    enabled?: boolean
    targets?: unknown[]
  }
  lock?: {
    resolved_sha?: string
  }
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

function isFirstPartyClaxedoMcpInstall(input: AgentExtensionMaterializationInstall) {
  const source = input.desired.source
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
  await fs.rm(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true })
}

async function removeMaterializedComponent(component: MaterializedComponent) {
  if (component.status !== "applied" || !component.path) return
  if (component.type !== "mcp") {
    await removeTreeOrLink(component.path)
    return
  }
  await removeStandaloneMcpEntries({ file: component.path, names: [component.component] })
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
  const discovered = await discoverAgentExtensionComponents(input.packageRoot)

  for (const runner of targets(input.install)) {
    if (discovered.length > 0) {
      for (const component of discovered) {
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

  return {
    package_name: name,
    source: input.install.desired.source,
    resolved_sha: input.install.lock?.resolved_sha ?? "",
    enabled: true,
    targets: targets(input.install),
    components,
    materialized_at: input.materializedAt,
    status: status(components, input.install.status),
  } satisfies MaterializedExtensionPackage
}

export async function materializeAgentExtensionSnapshot(input: AgentExtensionMaterializeOptions) {
  const materializedFile = path.join(input.stateRoot, "materialized.json")
  const previous = await readMaterializedRuntimeRecord(materializedFile)
  const materializedAt = now(input)
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
      return [[install.desired.id, await materializePackage({
        install,
        packageRoot,
        projectDir: input.projectDir,
        homeDir: input.homeDir,
        previous,
        materializedAt,
        replaceOwned: input.replaceOwned ?? !!existing,
      })]]
    }))).flat() as Array<[string, MaterializedExtensionPackage]>
  const packages = sorted(Object.fromEntries(packageEntries) as Record<string, MaterializedExtensionPackage>)
  const next = {
    version: 1 as const,
    packages,
  }
  await removeStaleMaterializedComponents(previous, next)
  await writeMaterializedRuntimeRecord(materializedFile, next)
  return readMaterializedRuntimeRecord(materializedFile)
}
