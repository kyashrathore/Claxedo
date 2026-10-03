import { Route, useLocation, useNavigate } from "@solidjs/router"
import { createContext, createMemo, createSignal, useContext, type Accessor, type JSX } from "solid-js"
import type { PlacementId, SessionId } from "@/server"
import { useShellRegistries } from "./registries"
import { HistoryRouter } from "./history-router"
import { parseRoute, placementOf, type ShellRoute } from "./routes"

export type SessionPlacementResolver = (session: SessionId) => PlacementId | undefined

export type ShellRouting = {
  readonly route: Accessor<ShellRoute>
  readonly placementId: Accessor<PlacementId | undefined>
  readonly resolveSessions: (resolver: SessionPlacementResolver) => () => void
  readonly pathname: Accessor<string>
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void
}

const ShellRoutingContext = createContext<ShellRouting>()

function RoutingProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const registries = useShellRegistries()
  const parsed = createMemo(() => parseRoute(location.pathname, registries.pages.list(), registries.routes.list()))
  const [resolver, setResolver] = createSignal<SessionPlacementResolver>()
  const localPlacement = createMemo(() => {
    const current = parsed()
    return current.kind === "localSession" ? resolver()?.(current.sessionId) : undefined
  })
  const route = createMemo((): ShellRoute => {
    const current = parsed()
    const placement = localPlacement()
    if (current.kind !== "localSession" || !placement) return current
    return { kind: "session", placementId: placement, sessionId: current.sessionId }
  })
  const routing: ShellRouting = {
    route,
    placementId: createMemo(() => placementOf(route())),
    resolveSessions: (next) => {
      setResolver(() => next)
      return () => setResolver((current) => (current === next ? undefined : current))
    },
    pathname: () => location.pathname,
    navigate: (path, options) => navigate(path, { replace: options?.replace ?? false }),
  }
  return <ShellRoutingContext.Provider value={routing}>{props.children}</ShellRoutingContext.Provider>
}

export type ShellRouterComponent = (props: { readonly children?: JSX.Element }) => JSX.Element

export function ShellRouter(props: { readonly router?: ShellRouterComponent; readonly children: JSX.Element }): JSX.Element {
  const Base = props.router ?? HistoryRouter
  return (
    <Base>
      <Route path="*rest" component={() => <RoutingProvider>{props.children}</RoutingProvider>} />
    </Base>
  )
}

export function useShellRoute(): ShellRouting {
  const routing = useContext(ShellRoutingContext)
  if (!routing) throw new Error("useShellRoute needs a ShellRouter above it")
  return routing
}
