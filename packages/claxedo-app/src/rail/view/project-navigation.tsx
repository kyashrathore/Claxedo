import { createSignal, type JSX } from "solid-js"
import { createNavigationGeometry } from "../navigation-geometry"
import { NavigationViewportProvider } from "../navigation-viewport"
import { ProjectTree } from "./project-tree"
import { SharedSessionsSection } from "./shared-sessions"

export function ProjectNavigation(): JSX.Element {
  const [scroller, setScroller] = createSignal<HTMLDivElement>()
  const [content, setContent] = createSignal<HTMLDivElement>()
  const geometry = createNavigationGeometry(scroller, content)
  return <NavigationViewportProvider scroller={scroller} geometry={geometry}><div ref={setScroller} class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rail-sidebar-scroll"><div ref={setContent}><ProjectTree /><SharedSessionsSection scroller={scroller} geometry={geometry} /></div></div></NavigationViewportProvider>
}
