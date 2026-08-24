/**
 * Host surface for user-extension views.
 *
 * One first-party surface renders every extension view: the pane's meta names
 * a view id, this component resolves it against the reactive view registry and
 * hands the extension a container element to render into. Resolution is live —
 * a pane restored from persisted state before extensions finish loading shows
 * the fallback, then mounts the view the moment its extension activates
 * (`userExtensionView` tracks the registry's revision signal).
 *
 * Deliberately dependency-free beyond solid: it sits in the eager surface list
 * next to SessionContent, so it must not pull anything into the boot closure.
 */

import { onCleanup, Show } from "solid-js"
import { userExtensionView, type UserExtensionView } from "@/platform/extensions/user-extension-views"
import type { ContentMeta } from "../state/index"

export function ExtensionViewContent(props: { meta: ContentMeta }) {
  const viewId = () =>
    props.meta.viewId ?? (props.meta.content?.type === "extension-view" ? props.meta.content.viewId : undefined)
  const view = () => {
    const id = viewId()
    return id ? userExtensionView(id) : undefined
  }
  return (
    <Show
      when={view()}
      keyed
      fallback={
        <div data-testid="extension-view-missing" style={{ padding: "2rem", opacity: "0.7" }}>
          This tab belongs to a user extension that is not loaded.
        </div>
      }
    >
      {(resolved) => <MountedExtensionView view={resolved} directory={props.meta.directory} />}
    </Show>
  )
}

/** Created fresh per view (the Show above is keyed), so mount runs exactly once per view identity. */
function MountedExtensionView(props: { view: UserExtensionView; directory?: string }) {
  const container = document.createElement("div")
  container.dataset.userExtensionView = props.view.id
  container.style.height = "100%"
  container.style.overflow = "auto"
  let dispose: (() => void) | void
  try {
    dispose = props.view.mount(container, { directory: props.directory })
  } catch (error) {
    console.warn(
      `[user-extensions] ${props.view.id} failed to mount: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  onCleanup(() => {
    try {
      dispose?.()
    } catch {
      // A throwing dispose must not break pane teardown.
    }
  })
  return container
}
