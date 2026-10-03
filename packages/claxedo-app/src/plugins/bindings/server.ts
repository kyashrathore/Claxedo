import { pluginOperationAllowed, pluginRouteAllowed, type PluginApi } from "@claxedo/plugin-api"
import type { BindingScope } from "./services"

const ROUTE_BASE = "http://plugin.route"

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

export function serverBinding(scope: BindingScope): PluginApi["server"] {
  const { manifest, services } = scope
  return {
    fetch: async (path, init) => {
      const url = sameServerPath(path)
      if (!url || !pluginRouteAllowed(manifest, url.pathname)) throw new PluginAccessError(manifest.id, path)
      return services.calls.fetch(`${url.pathname}${url.search}`, withPluginSignal(init, scope.signal))
    },
    operation: async (name, input) => {
      if (!pluginOperationAllowed(manifest, name)) throw new PluginAccessError(manifest.id, name)
      return services.calls.operation(name, input)
    },
  }
}
