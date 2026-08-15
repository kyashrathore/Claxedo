import { lazy, Suspense, type Component } from "solid-js"

/**
 * `lazy()` for components mounted through `useDialog().show/push`.
 *
 * The dialog host (`@opencode-ai/ui` DialogProvider) mounts dialog elements
 * inside `startTransition` under the CALLER's owner, with no Suspense boundary
 * of its own. A bare `lazy()` dialog therefore suspends the nearest ancestor
 * boundary — in practice the one wrapping the whole workbench — and the
 * transition re-renders that entire subtree when the chunk lands: the session
 * timeline remounts, per-row UI state (fold/expand) resets, and scroll snaps.
 * Wrapping the lazy component in its own local Suspense keeps the suspension
 * contained to the dialog overlay.
 */
export function lazyDialog<T extends Component<any>>(load: () => Promise<{ default: T }>): T {
  const Inner = lazy(load)
  const Wrapped = (props: Parameters<T>[0]) => (
    <Suspense fallback={null}>
      <Inner {...props} />
    </Suspense>
  )
  return Wrapped as T
}
