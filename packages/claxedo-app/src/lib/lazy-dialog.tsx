import { lazy, onMount, type Component, type ComponentProps } from "solid-js"

/**
 * `lazy()` for components mounted through `useDialog().show/push`.
 *
 * The Suspense boundary these suspend belongs to the dialog host
 * (`@opencode-ai/ui` DialogProvider): it wraps each mounted dialog, which both
 * keeps the suspension off the workbench boundary — where the transition would
 * remount the session timeline and reset per-row fold state and scroll when the
 * chunk landed — and is how `show()` knows a replacement has content before it
 * takes the replaced dialog off the screen. A local boundary here would absorb
 * the suspension and hide that.
 */
export function lazyDialog<T extends Component<any>>(
  load: () => Promise<{ default: T }>,
): Component<ComponentProps<T>> {
  const Inner = lazy(load)
  // Returning `Component<ComponentProps<T>>` rather than `T` is what removes
  // the assertion this used to end on: the wrapper genuinely is a component
  // over the same props, and it was only ever claimed to be the SAME component
  // so that callers kept their prop types. They still do.
  const Wrapped: Component<ComponentProps<T>> = (props) => (
    <>
      <Inner {...props} />
      <AriaHiddenPortalRepair />
    </>
  )
  return Wrapped
}

/**
 * Repairs the stacked-modal aria race the lazy chunk gap opens.
 *
 * When a modal dialog is pushed ON TOP of another (e.g. the Settings
 * connections page pushing `DialogConnectIntegration`), the DialogProvider appends the new
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
 * Mounted as a sibling of the lazy content inside the same Suspense boundary,
 * this sentinel runs exactly when the real dialog content lands: at that instant
 * this dialog is the top-most modal, so its portal (the direct `body` child
 * containing it) must not be aria-hidden. Kobalte's refcount bookkeeping stays
 * consistent — the outer modal's cleanup removes the attribute again on close,
 * which is a no-op here. Eager (non-lazy) dialogs never hit the race: portal
 * and content commit in one task, and the inner hide-outside disconnects the
 * outer observer before its queued records are delivered.
 */
function AriaHiddenPortalRepair() {
  let sentinel: HTMLSpanElement | undefined
  onMount(() => {
    let node: HTMLElement | null = sentinel ?? null
    while (node && node.parentElement !== document.body) node = node.parentElement
    if (node?.getAttribute("aria-hidden") === "true") node.removeAttribute("aria-hidden")
  })
  return <span ref={sentinel} style={{ display: "none" }} aria-hidden="true" />
}
