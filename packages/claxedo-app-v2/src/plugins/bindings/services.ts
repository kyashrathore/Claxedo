import type { Accessor } from "solid-js"
import type { CommandContext, PluginManifest, PluginPlatform } from "@claxedo/plugin-api"
import type { I18n } from "@/i18n"
import type { Project, Server } from "@/server"
import type { SessionStores } from "@/session"
import type { Commands, ShellRegistries, ShellRouting } from "@/shell"
import type { useDialog } from "@/ui"
import type { WorkbenchStore } from "@/workbench"
import type { PluginServerCalls } from "../api"
import type { RegistrationSink } from "../registrations"
import type { OverlayTracker } from "./overlays"

export type HostServices = {
  readonly registries: ShellRegistries
  readonly commands: Commands
  readonly workbench: WorkbenchStore
  readonly routing: ShellRouting
  readonly server: Server
  readonly sessions: SessionStores
  readonly i18n: I18n
  readonly dialog: ReturnType<typeof useDialog>
  readonly platform: PluginPlatform
  readonly projects: Accessor<readonly Project[]>
  readonly overlays: OverlayTracker
  readonly calls: PluginServerCalls
}

export type BindingScope = {
  readonly manifest: PluginManifest
  readonly sink: RegistrationSink
  readonly signal: AbortSignal
  readonly services: HostServices
}

export class PluginEntryError extends Error {
  constructor(readonly pluginId: string, message: string) {
    super(`${pluginId}: ${message}`)
    this.name = "PluginEntryError"
  }
}

export function entryId(pluginId: string, id: string): string {
  return `${pluginId}/${id}`
}

export function commandContext(services: HostServices): CommandContext {
  const route = services.routing.route()
  if (route.kind !== "session") return { projectId: currentProjectId(services) }
  return { sessionId: route.sessionId, projectId: currentProjectId(services) }
}

export function currentProjectId(services: HostServices): string | undefined {
  const placementId = services.routing.placementId()
  if (placementId) return services.server.placements.byId(placementId)?.projectId
  const route = services.routing.route()
  return route.kind === "page" ? route.params.projectId : undefined
}
