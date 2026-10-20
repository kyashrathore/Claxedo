import { useQuery } from "@tanstack/solid-query"
import { createContext, createEffect, createMemo, getOwner, on, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import type { PluginCapability, PluginPlatform } from "@claxedo/plugin-api"
import { useI18n } from "@/i18n"
import { desktopBridge } from "@/lib/desktop-bridge"
import { useServer } from "@/server"
import { useSessionStores } from "@/session"
import { useCommands, useShellRegistries, useShellRoute } from "@/shell"
import { useDialog } from "@/ui"
import { useWorkbench } from "@/workbench"
import { activatePlugin, type Activation } from "./activation"
import { pluginServerCalls } from "./api"
import { createApiFactory, createClaims, createOverlayTracker, type HostServices } from "./bindings"
import { createPluginHost, type PluginHost } from "./host"
import { pluginsDictionary, usePluginsText } from "./i18n"
import { createFrameRuntimeSource, type FrameRuntime } from "./frame/runtime-source"
import { FIRST_PARTY_BUNDLES } from "./first-party/bundles"
import { frameBundleLoader, inAppBundleLoader, loadFirstPartyPlugins } from "./first-party/load"
import { createInstalledReconciler } from "./installed/controller"
import { loadInstalledBuild } from "./installed/load"
import { createLiveReconciler } from "./live/controller"
import { liveListState, type LiveListState } from "./live/list-state"
import { loadFrameBuild, loadLiveBuild, type LiveRow } from "./live/load"
import { liveOriginOf, type PluginBuild } from "./model"
import { createPluginPreferences, safeModeRequested } from "./preferences"
import { approvalLetsRun } from "./approval"
import { requestApproval } from "./view/approval-request"

export type PluginsContext = PluginHost & {
  readonly platform: PluginPlatform
  readonly liveList: Accessor<LiveListState>
  readonly signedIn: Accessor<boolean>
  readonly requestApproval: (pluginId: string) => void
}

const PluginHostContext = createContext<PluginsContext>()

export function usePluginHost(): PluginsContext {
  const host = useContext(PluginHostContext)
  if (!host) throw new Error("usePluginHost needs a PluginHostProvider above it")
  return host
}

function currentPlatform(): PluginPlatform {
  return desktopBridge() ? "desktop" : "web"
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
  return (build: PluginBuild, onCrash: (reason: string) => void): Promise<Activation> => activatePlugin({ build, buildApi, onCrash, owner: services.owner })
}

function useBundledPlugins(host: PluginHost, services: HostServices, runtime: FrameRuntime): void {
  const load = services.platform === "desktop" ? inAppBundleLoader() : frameBundleLoader({ runtime, services })
  onCleanup(loadFirstPartyPlugins(FIRST_PARTY_BUNDLES, load, host.put))
}

function useLiveList(host: PluginHost, services: HostServices, runtime: FrameRuntime): Accessor<LiveListState> {
  const loadBuild = (row: LiveRow) =>
    services.platform === "desktop" ? loadLiveBuild(row, services.calls) : loadFrameBuild(row, services.calls, { runtime, services })
  const reconciler = createLiveReconciler(host, loadBuild)
  const offered = () => services.platform === "desktop" && services.server.queries.appPlugins.offered && services.server.capabilities()?.features.livePlugins === true
  const list = useQuery(() => ({ ...services.calls.livePlugins(), enabled: offered() }))
  createEffect(on(() => list.data, (rows) => rows && reconciler.reconcile(rows)))
  return createMemo(() => liveListState({ offered: offered(), listed: list.data !== undefined, error: list.error }))
}

function useInstalledPlugins(host: PluginHost, services: HostServices, runtime: FrameRuntime): void {
  const reconciler = createInstalledReconciler(host, (plugin) => loadInstalledBuild(plugin, services.calls, { runtime, services }))
  const offered = () => services.server.queries.appPlugins.offered && !host.safeMode()
  const list = useQuery(() => ({ ...services.calls.installedPlugins(), enabled: offered() }))
  createEffect(on([() => list.data, offered], ([plugins, running]) => running && plugins && reconciler.reconcile(plugins)))
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
      if (liveOriginOf(plugin)?.builtAt === undefined || approvalLetsRun(plugin.approval)) continue
      const build = `${plugin.id}:${plugin.origin.hash}`
      if (asked.has(build)) continue
      asked.add(build)
      request(plugin.id)
    }
  })
  return request
}

function offeredCapability(services: HostServices) {
  return (capability: PluginCapability) => services.server.capabilities()?.plugins.has(capability) === true
}

export function PluginHostProvider(props: { readonly scope: string; readonly children: JSX.Element }): JSX.Element {
  const services = useHostServices()
  onCleanup(services.i18n.add(pluginsDictionary))
  const host = createPluginHost({
    preferences: createPluginPreferences(props.scope, safeModeRequested(window.location.search)),
    offered: offeredCapability(services),
    activate: createActivate(services),
    removeLive: services.calls.removeLive,
  })
  onCleanup(host.dispose)
  const runtime = createFrameRuntimeSource()
  useBundledPlugins(host, services, runtime)
  useInstalledPlugins(host, services, runtime)
  const value: PluginsContext = {
    ...host,
    platform: services.platform,
    liveList: useLiveList(host, services, runtime),
    signedIn: () => services.server.queries.appPlugins.offered,
    requestApproval: useLiveApprovals(host, services),
  }
  return <PluginHostContext.Provider value={value}>{props.children}</PluginHostContext.Provider>
}
