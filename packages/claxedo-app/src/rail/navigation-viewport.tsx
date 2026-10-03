import { createContext, useContext, type Accessor, type JSX } from "solid-js"

type NavigationViewport = { readonly scroller: Accessor<HTMLElement | undefined>; readonly geometry: Accessor<number> }
const NavigationViewportContext = createContext<NavigationViewport>()

export function NavigationViewportProvider(props: NavigationViewport & { readonly children: JSX.Element }): JSX.Element {
  return <NavigationViewportContext.Provider value={props}>{props.children}</NavigationViewportContext.Provider>
}

export function useNavigationViewport(): NavigationViewport {
  const viewport = useContext(NavigationViewportContext)
  if (!viewport) throw new Error("useNavigationViewport needs NavigationViewportProvider")
  return viewport
}
