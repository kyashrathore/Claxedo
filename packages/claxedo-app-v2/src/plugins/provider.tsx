import { useQuery } from "@tanstack/solid-query"
import { createContext, createEffect, on, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
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
import { confirmLivePlugin } from "./view/confirm-live"

export type PluginsContext = PluginHost & {
  readonly platform: PluginPlatform
  readonly liveListError: Accessor<string | undefined>
  readonly requestConfirmation: (pluginId: string) => void
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
  const server = useServer()
  const commands = useCommands()
  const projects = useQuery(() => server.queries.projects.list())
  return {
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
    calls: pluginServerCalls(),
    claims: createClaims(),
  }
}

function createActivate(services: HostServices) {
  const buildApi = createApiFactory(services)
  return (build: PluginBuild, onCrash: (reason: string) => void): Promise<Activation> => activatePlugin({ build, buildApi, onCrash })
}

function useLiveList(host: PluginHost, services: HostServices): Accessor<string | undefined> {
  const options = services.calls.livePlugins()
  if (!options) return () => undefined
  const runtime = createFrameRuntimeSource()
  const loadBuild = (row: LiveRow) =>
    services.platform === "desktop" ? loadLiveBuild(row, services.calls) : loadFrameBuild(row, services.calls, { runtime, services })
  const reconciler = createLiveReconciler(host, loadBuild)
  const list = useQuery(() => options)
  createEffect(on(() => list.data, (rows) => rows && reconciler.reconcile(rows)))
  return () => (list.error ? failureReason(list.error) : undefined)
}

function useLiveConfirmations(host: PluginHost, services: HostServices): (pluginId: string) => void {
  const t = usePluginsText()
  const asked = new Set<string>()
  const request = (pluginId: string) => {
    const plugin = host.plugins().find((candidate) => candidate.id === pluginId)
    if (plugin) void confirmLivePlugin({ host, dialog: services.dialog, platform: services.platform, t }, plugin)
  }
  createEffect(() => {
    if (host.safeMode()) return
    for (const plugin of host.plugins()) {
      if (plugin.origin.kind !== "live" || plugin.confirmed || asked.has(plugin.id)) continue
      asked.add(plugin.id)
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
    requestConfirmation: useLiveConfirmations(host, services),
  }
  return <PluginHostContext.Provider value={value}>{props.children}</PluginHostContext.Provider>
}
