import { useQuery } from "@tanstack/solid-query"
import { createContext, createEffect, getOwner, on, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import type { PluginCapability, PluginPlatform } from "@claxedo/plugin-api"
import { useI18n } from "@/i18n"
import { useServer } from "@/server"
import { useSessionStores } from "@/session"
import { useCommands, useShellRegistries, useShellRoute } from "@/shell"
import { useDialog } from "@/ui"
import { useWorkbench } from "@/workbench"
import { activatePlugin, type Activation } from "./activation"
import { pluginServerCalls } from "./api"
import { createApiFactory, createClaims, createOverlayTracker, type HostServices } from "./bindings"
import { failureReason } from "./failure"
import { bundledPlugins } from "./bundled"
import { createPluginHost, type PluginHost } from "./host"
import { dictionary, usePluginsText } from "./i18n"
import { createFrameRuntimeSource } from "./frame/runtime-source"
import { createLiveReconciler } from "./live/controller"
import { loadFrameBuild, loadLiveBuild, type LiveRow } from "./live/load"
import type { PluginBuild } from "./model"
import { createPluginPreferences, safeModeRequested } from "./preferences"
import { approvalLetsRun } from "./approval"
import { requestApproval } from "./view/approval-request"

export type PluginsContext = PluginHost & {
  readonly platform: PluginPlatform
  readonly liveListError: Accessor<string | undefined>
  readonly requestApproval: (pluginId: string) => void
}

const PluginHostContext = createContext<PluginsContext>()

export function usePluginHost(): PluginsContext {
  const host = useContext(PluginHostContext)
  if (!host) throw new Error("usePluginHost needs a PluginHostProvider above it")
  return host
}

function currentPlatform(): PluginPlatform {
  return typeof (globalThis as { api?: unknown }).api === "object" ? "desktop" : "web"
}

function useHostServices(): HostServices {
  const owner = getOwner()
  if (!owner) throw new Error("The plugin host needs a reactive owner")
  const server = useServer()
  const commands = useCommands()
  const projects = useQuery(() => server.queries.projects.list())
  return {
    owner,
    registries: useShellRegistries(),
    commands,
    workbench: useWorkbench(),
    routing: useShellRoute(),
    server,
    sessions: useSessionStores(),
    i18n: useI18n(),
    dialog: useDialog(),
    platform: currentPlatform(),
    projects: () => projects.data ?? [],
    overlays: createOverlayTracker(commands),
    calls: pluginServerCalls(server),
    claims: createClaims(),
  }
}

function createActivate(services: HostServices) {
  const buildApi = createApiFactory(services)
  return (build: PluginBuild, onCrash: (reason: string) => void): Promise<Activation> => activatePlugin({ build, buildApi, onCrash })
}

function useLiveList(host: PluginHost, services: HostServices): Accessor<string | undefined> {
  const runtime = createFrameRuntimeSource()
  const loadBuild = (row: LiveRow) =>
    services.platform === "desktop" ? loadLiveBuild(row, services.calls) : loadFrameBuild(row, services.calls, { runtime, services })
  const reconciler = createLiveReconciler(host, loadBuild)
  const list = useQuery(() => ({ ...services.calls.livePlugins(), enabled: services.server.capabilities()?.features.livePlugins === true }))
  createEffect(on(() => list.data, (rows) => rows && reconciler.reconcile(rows)))
  return () => (list.error ? failureReason(list.error) : undefined)
}

function useLiveApprovals(host: PluginHost, services: HostServices): (pluginId: string) => void {
  const t = usePluginsText()
  const asked = new Set<string>()
  const request = (pluginId: string) => {
    const plugin = host.plugins().find((candidate) => candidate.id === pluginId)
    if (plugin) requestApproval({ host, dialog: services.dialog, t, platform: services.platform }, plugin)
  }
  createEffect(() => {
    if (host.safeMode()) return
    for (const plugin of host.plugins()) {
      if (plugin.origin.kind !== "live" || plugin.origin.builtAt === undefined || approvalLetsRun(plugin.approval)) continue
      const build = `${plugin.id}:${plugin.origin.hash}`
      if (asked.has(build)) continue
      asked.add(build)
      request(plugin.id)
    }
  })
  return request
}

function useOfferedCapabilities(services: HostServices, required: Accessor<ReadonlySet<PluginCapability>>) {
  const tasks = useQuery(() => ({ ...services.server.queries.tasks.availability(), enabled: required().has("tasks") }))
  const offered: Record<PluginCapability, () => boolean> = {
    documents: () => services.server.capabilities()?.features.documents === true,
    tasks: () => tasks.data?.kind === "available",
  }
  return (capability: PluginCapability) => offered[capability]()
}

export function PluginHostProvider(props: { readonly scope: string; readonly children: JSX.Element }): JSX.Element {
  const services = useHostServices()
  onCleanup(services.i18n.add(dictionary))
  const host = createPluginHost({
    preferences: createPluginPreferences(props.scope, safeModeRequested(window.location.search)),
    offered: (capability) => offered(capability),
    activate: createActivate(services),
    removeLive: services.calls.removeLive,
  })
  const offered = useOfferedCapabilities(services, host.required)
  for (const build of bundledPlugins()) host.put(build)
  onCleanup(host.dispose)
  const value: PluginsContext = {
    ...host,
    platform: services.platform,
    liveListError: useLiveList(host, services),
    requestApproval: useLiveApprovals(host, services),
  }
  return <PluginHostContext.Provider value={value}>{props.children}</PluginHostContext.Provider>
}
