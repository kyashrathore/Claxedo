import { useQuery } from "@tanstack/solid-query"
import { createContext, onCleanup, useContext, type JSX } from "solid-js"
import type { PluginPlatform } from "@claxedo/plugin-api"
import { useI18n } from "@/i18n"
import { useServer } from "@/server"
import { useSessionStores } from "@/session"
import { useCommands, useShellRegistries, useShellRoute } from "@/shell"
import { useDialog } from "@/ui"
import { useWorkbench } from "@/workbench"
import { activatePlugin } from "./activation"
import { pluginServerCalls } from "./api"
import { createApiFactory, createOverlayTracker, type HostServices } from "./bindings"
import { bundledPlugins } from "./bundled"
import { createPluginHost, type PluginHost } from "./host"
import { dictionary } from "./i18n"
import { createPluginPreferences, safeModeRequested } from "./preferences"

const PluginHostContext = createContext<PluginHost>()

export function usePluginHost(): PluginHost {
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
  }
}

export function PluginHostProvider(props: { readonly scope: string; readonly children: JSX.Element }): JSX.Element {
  const services = useHostServices()
  onCleanup(services.i18n.add(dictionary))
  const buildApi = createApiFactory(services)
  const host = createPluginHost({
    preferences: createPluginPreferences(props.scope, safeModeRequested(window.location.search)),
    features: () => services.server.capabilities()?.features,
    activate: (build, onCrash) => activatePlugin({ build, buildApi, onCrash }),
    removeLive: services.calls.removeLive,
  })
  for (const build of bundledPlugins()) host.put(build)
  onCleanup(host.dispose)
  return <PluginHostContext.Provider value={host}>{props.children}</PluginHostContext.Provider>
}
