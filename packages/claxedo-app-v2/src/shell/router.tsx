import { Route, Router, useLocation, useNavigate } from "@solidjs/router"
import { createContext, createMemo, useContext, type Accessor, type JSX } from "solid-js"
import type { PlacementId } from "@/server"
import { useShellRegistries } from "./registries"
import { parseRoute, placementOf, type ShellRoute } from "./routes"

export type ShellRouting = {
  readonly route: Accessor<ShellRoute>
  readonly placementId: Accessor<PlacementId | undefined>
  readonly pathname: Accessor<string>
  readonly navigate: (path: string, options?: { readonly replace?: boolean }) => void
}

const ShellRoutingContext = createContext<ShellRouting>()

function RoutingProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const location = useLocation()
  const navigate = useNavigate()
  const registries = useShellRegistries()
  const route = createMemo(() => parseRoute(location.pathname, registries.pages.list(), registries.routes.list()))
  const routing: ShellRouting = {
    route,
    placementId: createMemo(() => placementOf(route())),
    pathname: () => location.pathname,
    navigate: (path, options) => navigate(path, { replace: options?.replace ?? false }),
  }
  return <ShellRoutingContext.Provider value={routing}>{props.children}</ShellRoutingContext.Provider>
}

export function ShellRouter(props: { readonly children: JSX.Element }): JSX.Element {
  return (
    <Router>
      <Route path="*rest" component={() => <RoutingProvider>{props.children}</RoutingProvider>} />
    </Router>
  )
}

export function useShellRoute(): ShellRouting {
  const routing = useContext(ShellRoutingContext)
  if (!routing) throw new Error("useShellRoute needs a ShellRouter above it")
  return routing
}
