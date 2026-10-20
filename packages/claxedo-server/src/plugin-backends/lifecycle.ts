import type { D1Database } from "@cloudflare/workers-types"
import type { SignedPluginRelease } from "@claxedo/plugin-api/release"
import { pluginSupervisor, type PluginScope, type PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { AppPluginsBucket } from "./bundles"
import { putPluginBundle } from "./bundles"
import {
  readAppPluginInstall,
  writeAppPluginActive,
  writeAppPluginInstall,
  writeAppPluginUninstall,
  writeAppPluginUpdate,
  type AppPluginInstall,
} from "./installs"
import { deletePluginData } from "./platform-host"
import { fetchVerifiedBlob, fetchVerifiedRelease, type AppPluginRegistry } from "./registry"

export type AppPluginLifecyclePorts = Readonly<{
  database: D1Database
  bucket: AppPluginsBucket
  registry: AppPluginRegistry
  /** Absent on a deployment without the plugin-backend platform, which then refuses a release that carries a backend. */
  supervisors: PluginSupervisorNamespace | undefined
  now: () => number
}>

type LifecycleRefusalCode = "app_plugin_platform_unavailable" | "app_plugin_storage_downgrade" | "app_plugin_not_installed"

export class AppPluginLifecycleError extends ClaxedoError<LifecycleRefusalCode> {
  constructor(code: LifecycleRefusalCode, message: string) {
    super({ code, message })
  }
}

export type AppPluginReleaseRequest = PluginScope & Readonly<{ version: string; userId: string }>

/**
 * Verifies the release and copies both its bundles into this deployment's
 * store before any row names them, so an install never points at a bundle the
 * Worker cannot load.
 */
async function storedRelease(ports: AppPluginLifecyclePorts, request: AppPluginReleaseRequest): Promise<SignedPluginRelease> {
  const signed = await fetchVerifiedRelease(ports.registry, request.pluginId, request.version)
  const { release } = signed
  if (release.backend && !ports.supervisors) {
    throw new AppPluginLifecycleError("app_plugin_platform_unavailable", `plugin ${release.id} has a backend, and this deployment runs no plugin backends`)
  }
  await putPluginBundle(ports.bucket, "app", release.app.sha256, await fetchVerifiedBlob(ports.registry, release.app))
  if (release.backend) await putPluginBundle(ports.bucket, "backend", release.backend.sha256, await fetchVerifiedBlob(ports.registry, release.backend))
  return signed
}

/** Tells the plugin's supervisor to read its install again, so a run the change ended stops now. */
async function refresh(ports: AppPluginLifecyclePorts, scope: PluginScope) {
  if (ports.supervisors) await pluginSupervisor(ports.supervisors, scope).refresh(scope)
}

async function installed(ports: AppPluginLifecyclePorts, scope: PluginScope): Promise<AppPluginInstall> {
  const install = await readAppPluginInstall(ports.database, scope)
  if (!install) throw new AppPluginLifecycleError("app_plugin_not_installed", `This organization has not installed plugin ${scope.pluginId}`)
  return install
}

export async function installAppPlugin(ports: AppPluginLifecyclePorts, request: AppPluginReleaseRequest): Promise<AppPluginInstall> {
  const signed = await storedRelease(ports, request)
  await writeAppPluginInstall(ports.database, { orgId: request.orgId, signed, changedBy: request.userId, now: ports.now() })
  await refresh(ports, request)
  return installed(ports, request)
}

/** Replaces the installed release with `version`; a release whose storage generation is lower than the installed one's is refused. */
export async function updateAppPlugin(ports: AppPluginLifecyclePorts, request: AppPluginReleaseRequest): Promise<AppPluginInstall> {
  const current = await installed(ports, request)
  const signed = await storedRelease(ports, request)
  if (signed.release.storage < current.release.storage) {
    throw new AppPluginLifecycleError(
      "app_plugin_storage_downgrade",
      `${request.pluginId} ${request.version} stores generation ${signed.release.storage}, older than the installed ${current.release.storage}`,
    )
  }
  if (!(await writeAppPluginUpdate(ports.database, { orgId: request.orgId, signed, changedBy: request.userId, now: ports.now() }))) {
    throw new AppPluginLifecycleError("app_plugin_not_installed", `This organization has not installed plugin ${request.pluginId}`)
  }
  await refresh(ports, request)
  return installed(ports, request)
}

/** Turns the plugin off or back on for the whole organization; its storage is kept either way. */
export async function setAppPluginActive(ports: AppPluginLifecyclePorts, request: PluginScope & Readonly<{ active: boolean; userId: string }>): Promise<void> {
  await installed(ports, request)
  if (await writeAppPluginActive(ports.database, { ...request, changedBy: request.userId, now: ports.now() })) await refresh(ports, request)
}

/**
 * Deletes the install, every member's choice and the plugin's links, then
 * every object, wake and blob the plugin stored. The data is deleted even
 * when no install was found, so an uninstall that failed after its rows were
 * deleted completes on retry.
 */
export async function uninstallAppPlugin(ports: AppPluginLifecyclePorts, scope: PluginScope): Promise<boolean> {
  const removed = await writeAppPluginUninstall(ports.database, scope)
  if (ports.supervisors) await pluginSupervisor(ports.supervisors, scope).purge(scope)
  await deletePluginData(ports.bucket, scope)
  return removed
}
