import { pluginOperationAllowed, pluginRouteAllowed, type PluginApi } from "@claxedo/plugin-api"
import type { BindingScope } from "./services"

const ROUTE_BASE = "http://plugin.route"

const PLUGIN_BACKEND_OPERATION = "plugin.request"

export class PluginAccessError extends Error {
  constructor(readonly pluginId: string, readonly target: string) {
    super(`${pluginId} may not call ${target}: its manifest does not name it`)
    this.name = "PluginAccessError"
  }
}

function sameServerPath(path: string): URL | undefined {
  if (!path.startsWith("/")) return undefined
  const url = new URL(path, ROUTE_BASE)
  return url.origin === ROUTE_BASE ? url : undefined
}

function withPluginSignal(init: RequestInit | undefined, signal: AbortSignal): RequestInit {
  return { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal }
}

function backendBinding(scope: BindingScope): ReturnType<PluginApi["server"]["backend"]> {
  const { manifest, services } = scope
  if (!manifest.backend) throw new PluginAccessError(manifest.id, "a backend")
  return {
    fetch: async (path, init) => {
      const url = sameServerPath(path)
      if (!url) throw new PluginAccessError(manifest.id, path)
      return services.calls.backendFetch(manifest.id, `${url.pathname}${url.search}`, withPluginSignal(init, scope.signal))
    },
  }
}

export function serverBinding(scope: BindingScope): PluginApi["server"] {
  const { manifest, services } = scope
  return {
    fetch: async (path, init) => {
      const url = sameServerPath(path)
      if (!url || !pluginRouteAllowed(manifest, url.pathname)) throw new PluginAccessError(manifest.id, path)
      return services.calls.fetch(`${url.pathname}${url.search}`, withPluginSignal(init, scope.signal))
    },
    operation: async (name, input) => {
      if (name === PLUGIN_BACKEND_OPERATION || !pluginOperationAllowed(manifest, name)) throw new PluginAccessError(manifest.id, name)
      return services.calls.operation(name, input)
    },
    backend: () => backendBinding(scope),
  }
}
