import { Show, createContext, createEffect, createSignal, onCleanup, useContext, type JSX, type ParentProps } from "solid-js"
import { useLayout } from "@/app/providers/layout"
import { usePaneCtx } from "../context/pane-ctx"
import { MainContentReady } from "../../shell-revealed"

const ProjectCreateCanvasContext = createContext<() => JSX.Element>()

/** The create canvas that needs no project's runtime; the workbench canvas supplies it to its panes. */
export const ProjectCreateCanvasProvider = ProjectCreateCanvasContext.Provider

/**
 * What a pane shows in place of a workspace surface that cannot mount (its
 * host offline, access refused). It is settled content, so it releases the
 * boot splash, which otherwise waits for a composer that never comes. And
 * since no composer can mount here, the focused one is also where "New
 * Project" lands: it answers by becoming the create canvas, and stays that
 * for as long as the workspace stays unavailable.
 */
export function WorkspaceUnavailableSurface(props: ParentProps) {
  const layout = useLayout()
  const pane = usePaneCtx()
  const createCanvas = useContext(ProjectCreateCanvasContext)
  const [creating, setCreating] = createSignal(false)
  // A hidden retained pane, or the unfocused side of a split, must not answer:
  // the canvas would open where nobody is looking and consume the request.
  const answers = () => !!createCanvas && (!pane || (pane.isVisible() && pane.isFocused()))

  createEffect(() => {
    if (!answers()) return
    onCleanup(layout.projects.registerCreateSurface())
  })
  createEffect(() => {
    if (answers() && layout.projects.createPending()) setCreating(true)
  })

  return (
    <>
      <MainContentReady />
      <Show when={creating()} fallback={props.children}>
        {createCanvas?.()}
      </Show>
    </>
  )
}
