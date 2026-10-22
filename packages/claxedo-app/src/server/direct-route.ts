import { machine, unreachable, type Machine } from "../lib/machine"
import { responseErrorCode } from "./errors"
import type { DirectRoutes, RelayConnection } from "./wire/connection"

export type RuntimeRouteKind = "direct" | "relay"

export type RuntimeRouteState =
  | { readonly kind: "relay" }
  | { readonly kind: "probing"; readonly routes: DirectRoutes }
  | { readonly kind: "direct"; readonly routes: DirectRoutes }
  | { readonly kind: "refused"; readonly routes: DirectRoutes }

export type RuntimeRouteEvent =
  | { readonly type: "routesNamed"; readonly routes: DirectRoutes | undefined }
  | { readonly type: "answered" }
  | { readonly type: "refused" }
  | { readonly type: "recheck" }

export type DaemonSend = (path: string, init?: RequestInit) => Promise<Response>
export type DaemonSocket = (path: string, protocols: string[]) => WebSocket

export type DirectRoute = {
  readonly kind: (workspaceId: string) => RuntimeRouteKind
  readonly learn: (link: RelayConnection) => void
  readonly fetch: (link: RelayConnection, path: string, init?: RequestInit) => Promise<Response | undefined>
  readonly webSocket: (link: RelayConnection, path: string) => WebSocket | undefined
  readonly recheck: () => void
}

const DIRECT_ROUTE_UNAVAILABLE = "direct_route_unavailable"
const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."

function sameRoutes(a: DirectRoutes, b: DirectRoutes) {
  return a.port === b.port && a.spkiSha256 === b.spkiSha256 && a.addresses.join() === b.addresses.join()
}

export function transitionRuntimeRoute(state: RuntimeRouteState, event: RuntimeRouteEvent): RuntimeRouteState {
  switch (event.type) {
    case "routesNamed":
      if (!event.routes) return { kind: "relay" }
      return state.kind !== "relay" && sameRoutes(state.routes, event.routes) ? state : { kind: "probing", routes: event.routes }
    case "answered":
      return state.kind === "probing" ? { kind: "direct", routes: state.routes } : state
    case "refused":
      return state.kind === "relay" ? state : { kind: "refused", routes: state.routes }
    case "recheck":
      return state.kind === "refused" ? { kind: "probing", routes: state.routes } : state
    default:
      return unreachable(event)
  }
}

function directPath(workspaceId: string, path: string) {
  return `/direct/workspaces/${encodeURIComponent(workspaceId)}${path}`
}

async function registerRoutes(send: DaemonSend, workspaceId: string, routes: DirectRoutes): Promise<boolean> {
  try {
    const answer = await send(`/api/claxedo/direct-routes/${encodeURIComponent(workspaceId)}`, { method: "PUT", body: JSON.stringify(routes) })
    void answer.body?.cancel()
    return answer.ok
  } catch (error) {
    console.warn("The direct route could not be registered with this machine's daemon", { workspaceId, error })
    return false
  }
}

function routeMachines(send: DaemonSend) {
  const routes = new Map<string, Machine<RuntimeRouteState, RuntimeRouteEvent>>()
  const of = (workspaceId: string) => {
    const existing = routes.get(workspaceId)
    if (existing) return existing
    const created = machine<RuntimeRouteState, RuntimeRouteEvent>({ kind: "relay" }, transitionRuntimeRoute)
    routes.set(workspaceId, created)
    return created
  }
  const advance = (workspaceId: string, event: RuntimeRouteEvent) => {
    const route = of(workspaceId)
    const before = route.state()
    route.send(event)
    const after = route.state()
    if (after === before || after.kind !== "probing") return
    void registerRoutes(send, workspaceId, after.routes).then((ok) => {
      if (route.state() === after) route.send({ type: ok ? "answered" : "refused" })
    })
  }
  return { of, advance, all: () => [...routes.keys()] }
}

function refusedVisibly(machines: ReturnType<typeof routeMachines>, workspaceId: string, reason: string) {
  console.warn("The direct route to this workspace's machine stopped answering; its traffic goes through the relay", { workspaceId, reason })
  machines.advance(workspaceId, { type: "refused" })
}

export function createDirectRoute(send: DaemonSend, openSocket: DaemonSocket): DirectRoute {
  const machines = routeMachines(send)
  const kind = (workspaceId: string): RuntimeRouteKind => (machines.of(workspaceId).state().kind === "direct" ? "direct" : "relay")
  return {
    kind,
    learn: (link) => machines.advance(link.workspaceId, { type: "routesNamed", routes: link.directRoutes }),
    fetch: async (link, path, init) => {
      if (kind(link.workspaceId) !== "direct") return undefined
      const headers = new Headers(init?.headers)
      headers.set("Authorization", `Bearer ${link.runtimeAccessToken}`)
      const answer = await send(directPath(link.workspaceId, path), { ...init, headers })
      if (answer.status !== 503 || (await responseErrorCode(answer)) !== DIRECT_ROUTE_UNAVAILABLE) return answer
      void answer.body?.cancel()
      refusedVisibly(machines, link.workspaceId, DIRECT_ROUTE_UNAVAILABLE)
      return undefined
    },
    webSocket: (link, path) => {
      if (kind(link.workspaceId) !== "direct") return undefined
      const socket = openSocket(directPath(link.workspaceId, path), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
      let opened = false
      socket.addEventListener("open", () => { opened = true }, { once: true })
      socket.addEventListener("close", () => {
        if (!opened) refusedVisibly(machines, link.workspaceId, "socket_refused")
      }, { once: true })
      return socket
    },
    recheck: () => {
      for (const workspaceId of machines.all()) machines.advance(workspaceId, { type: "recheck" })
    },
  }
}
