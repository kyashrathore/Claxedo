import { lazy, onSettled, Loading, type Component } from "solid-js"

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
    <Loading fallback={null}>
      <Inner {...props} />
      <AriaHiddenPortalRepair />
    </Loading>
  )
  return Wrapped as T
}

/**
 * Repairs the stacked-modal aria race the lazy chunk gap opens.
 *
 * When a modal dialog is pushed ON TOP of another (e.g. `create-cloud-project`
 * pushing `DialogConnectIntegration`), the DialogProvider appends the new
 * Kobalte portal to `document.body` immediately, but a `lazyDialog` component
 * mounts its `Dialog.Content` only after the chunk resolves. In that gap the
 * OUTER modal's Kobalte `ariaHideOutside` MutationObserver
 * (`@kobalte/core/dist/primitives/create-hide-outside`) sees the new body
 * child, finds no visible target inside it, and stamps it `aria-hidden="true"`.
 * The inner dialog's own hide-outside pass (run when its content finally
 * mounts) only HIDES other nodes — it never un-hides its own ancestors — so
 * the freshly opened dialog stays invisible to the accessibility tree
 * (`getByRole` finds nothing, screen readers announce nothing) even though it
 * paints on screen.
 *
 * Mounted as a sibling of the lazy content inside the same Suspense, this
 * sentinel runs exactly when the real dialog content lands: at that instant
 * this dialog is the top-most modal, so its portal (the direct `body` child
 * containing it) must not be aria-hidden. Kobalte's refcount bookkeeping stays
 * consistent — the outer modal's cleanup removes the attribute again on close,
 * which is a no-op here. Eager (non-lazy) dialogs never hit the race: portal
 * and content commit in one task, and the inner hide-outside disconnects the
 * outer observer before its queued records are delivered.
 */
function AriaHiddenPortalRepair() {
  let sentinel: HTMLSpanElement | undefined
  onSettled(() => {
    let node: HTMLElement | null = sentinel ?? null
    while (node && node.parentElement !== document.body) node = node.parentElement
    if (node?.getAttribute("aria-hidden") === "true") node.removeAttribute("aria-hidden")
  })
  return <span ref={sentinel} style={{ display: "none" }} aria-hidden="true" />
}
