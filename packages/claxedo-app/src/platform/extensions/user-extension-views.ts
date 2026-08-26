/**
 * The registry of views user extensions have contributed.
 *
 * Its own module — separate from the loader — because two very different
 * consumers read it: the loader writes during activation, while the workbench
 * host surface and the command palette read it reactively. Same factory +
 * version-signal shape as `createContributionRegistry` in
 * `app/integrations/registry.ts`: the map is plain and mutable, and every
 * reader touches `revision()` so a view registered after a pane already
 * rendered still shows up.
 */

import { createSignal } from "solid-js"

export type UserExtensionViewContext = {
  /** Directory the hosting pane is scoped to, when it has one. */
  directory?: string
}

export type UserExtensionView = {
  /** Fully qualified `<extension-name>.<view-id>` — unique across extensions. */
  id: string
  title: string
  extension: { name: string; version: string }
  /**
   * Mounts the view into the container. Framework-agnostic by design: the
   * extension gets a live DOM element and may render into it however it likes.
   * The optional return value is called when the pane unmounts.
   */
  mount: (container: HTMLElement, context: UserExtensionViewContext) => (() => void) | void
}

function createUserExtensionViewRegistry() {
  const views = new Map<string, UserExtensionView>()
  const [revision, setRevision] = createSignal(0)
  const changed = () => setRevision((current) => current + 1)
  const track = () => void revision()

  return {
    register(view: UserExtensionView) {
      views.set(view.id, view)
      changed()
    },
    /** Removes every view an extension registered — the rollback for a failed activation. */
    removeExtension(extensionName: string) {
      let mutated = false
      for (const [id, view] of views) {
        if (view.extension.name !== extensionName) continue
        views.delete(id)
        mutated = true
      }
      if (mutated) changed()
    },
    all(): UserExtensionView[] {
      track()
      return [...views.values()]
    },
    get(id: string): UserExtensionView | undefined {
      track()
      return views.get(id)
    },
  }
}

const registry = createUserExtensionViewRegistry()

export function registerUserExtensionView(view: UserExtensionView) {
  registry.register(view)
}

export function removeUserExtensionViews(extensionName: string) {
  registry.removeExtension(extensionName)
}

export function userExtensionViews(): UserExtensionView[] {
  return registry.all()
}

export function userExtensionView(id: string): UserExtensionView | undefined {
  return registry.get(id)
}
