import { createMediaQuery } from "@solid-primitives/media"
import { useLocation, useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { createContext, useContext, type Accessor, type JSX } from "solid-js"
import { LIVE_PLUGINS_ROUTE, type PluginApi, type PluginModule } from "@claxedo/plugin-api"
import { useServer, type Project, type Server } from "@/server"
import type { ShellRegistries } from "@/shell/types"
import { bundledPlugins } from "./bundled"
import { NO_FEATURES, createDataBindings } from "./data-bindings"
import { createPluginHost, type PluginHost } from "./host"
import { createPluginI18n } from "./i18n"
import { createPluginPreferences, safeModeRequested } from "./preferences"
import type { RegistrationSink } from "./registrations"
import { createPluginServer } from "./server-access"
import { projectsQueryOptions, serverCalls } from "./server-calls"
import { registerHostEntries } from "./settings-section"
import { createShellBindings } from "./shell-bindings"
import { createNotices, createPluginUi } from "./ui"
import { createWorkbenchBinding } from "./workbench-binding"

const PluginHostContext = createContext<PluginHost>()

export function usePluginHost(): PluginHost {
  const host = useContext(PluginHostContext)
  if (!host) throw new Error("usePluginHost needs a PluginHostProvider above it")
  return host
}

function detectPlatform(): "desktop" | "web" {
  return typeof (globalThis as { api?: unknown }).api === "object" ? "desktop" : "web"
}

function useProjectsList(server: Server): Accessor<readonly Project[]> {
  const options = projectsQueryOptions(server)
  if (!options) return () => []
  const query = useQuery(() => options())
  return () => query.data ?? []
}

export function PluginHostProvider(props: { readonly registries: ShellRegistries; readonly children: JSX.Element }) {
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()
  const notices = createNotices()
  const ui = createPluginUi(notices)
  const userKey = () => {
    const principal = server.capabilities()?.principal
    return principal?.kind === "user" ? principal.userId : "machine"
  }
  const preferences = createPluginPreferences(userKey, safeModeRequested(window.location.search))
  const projects = useProjectsList(server)
  const phone = createMediaQuery("(max-width: 480px)")
  const language = () => "en"
  const platform = detectPlatform()
  const calls = serverCalls(server)
  const workbench = createWorkbenchBinding()

  const buildApi = (module: PluginModule, sink: RegistrationSink): PluginApi => ({
    id: module.manifest.id,
    ...createShellBindings({ pluginId: module.manifest.id, pluginName: module.manifest.name, registries: props.registries, sink }),
    ...createDataBindings({
      server,
      navigate: (path) => navigate(path),
      pathname: () => location.pathname,
      projects,
      sessionStatus: () => undefined,
      platform,
      language,
      phone,
    }),
    workbench,
    server: createPluginServer(module.manifest, calls),
    ui,
    i18n: createPluginI18n(language),
    preferences: { persisted: (key, initial) => preferences.persisted(module.manifest.id, key, initial) },
    navigate: (path) => navigate(path),
  })

  const host = createPluginHost({
    preferences,
    features: () => server.capabilities()?.features ?? NO_FEATURES,
    buildApi,
    removeLive: async (id) => {
      const response = await calls.request({ method: "DELETE", path: `${LIVE_PLUGINS_ROUTE}/${encodeURIComponent(id)}` })
      if (!response.ok) throw new Error(`Removing plugin ${id} failed with ${response.status}`)
    },
  })
  for (const module of bundledPlugins) host.add(module, { kind: "bundled" })
  registerHostEntries(host, props.registries)

  return (
    <PluginHostContext.Provider value={host}>
      {props.children}
      <notices.Region />
    </PluginHostContext.Provider>
  )
}
