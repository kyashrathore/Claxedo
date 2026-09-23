/**
 * Which inner Workspace tabs own DOM.
 *
 * Only the active one: keeping a closed or inactive tab mounted would leave it
 * still owning a live DOM tree, its listeners, and its observers — exactly the
 * hidden ownership a disposed Workspace is supposed to give back. What a tab
 * needs to come back is restored instead: the panel's working set carries the
 * tab list and the Review surface, and TabFile re-reads from the canonical
 * request cache.
 *
 * The one exception is a tab whose activation is prepared but not yet
 * committed. It mounts for that frame so its content is laid out before it
 * becomes active — the ordering `createReviewTabActivation` relies on to
 * capture the Review scroll before a tab insertion can clamp it.
 *
 * Review retains its semantic working set while another tab is active, but its
 * DOM surface is unmounted and reconstructed from that state when selected
 * again (review-workspace.tsx). Retaining file-tab bodies instead fails on
 * correctness rather than ownership: a retained body cannot hold its rendered
 * content. Display-locked (`content-visibility: hidden`), the Pierre text
 * viewer's window collapses to zero rows and nothing redraws them — it renders
 * once per options change and windows its virtualizer against a scroll parent
 * it cannot measure while the subtree is skipped. Merely hidden
 * (`visibility: hidden`, or `opacity: 0` with paint order), whatever tears the
 * window down — a navigator opening beside it is enough — is never followed by
 * a redraw, so reveals are blank at random. The unmount/remount is what hides
 * that fragility; retention needs the viewer to redraw on reveal
 * (session-ui/components/file.tsx) first.
 */
export function reviewWorkspaceMountedTabs<Tab extends { id: string; kind: string }>(input: {
  tabs: readonly Tab[]
  activeTabId: string
  reviewTabId: string
  pendingTabId?: string
}): Tab[] {
  const active = input.activeTabId === input.reviewTabId ? undefined : input.activeTabId
  return input.tabs.filter((tab) =>
    tab.kind !== "review" && (tab.id === active || tab.id === input.pendingTabId)
  )
}

/**
 * The one last-interaction-wins path for committing inner-tab activations.
 *
 * An activation for a freshly inserted tab is deferred one frame: the tab
 * mounts as `pendingTabId` (see above) so its content is laid out before it
 * becomes active. Every activation — deferred or direct — flows through
 * `commit`, and each new one cancels a pending deferred one first, so an older
 * deferred activation can never overwrite the user's later direct tab click
 * one frame after it happened.
 */
export function createReviewTabActivationTransition<Activation extends { id: string }>(input: {
  commit: (activation: Activation) => void
  setPendingTabId: (id: string | undefined) => void
}) {
  let pendingFrame: number | undefined

  const cancel = () => {
    if (pendingFrame !== undefined && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(pendingFrame)
    }
    pendingFrame = undefined
    // Also clears a pending mount whose deferred activation this supersedes;
    // leaving it set would keep that never-activated tab mounted forever.
    input.setPendingTabId(undefined)
  }

  return {
    /** Cancel a pending deferred activation without applying a new one. */
    cancel,
    commit: (activation: Activation, defer = false) => {
      cancel()
      if (!defer || typeof requestAnimationFrame !== "function") {
        input.commit(activation)
        return
      }
      input.setPendingTabId(activation.id)
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = undefined
        input.commit(activation)
        input.setPendingTabId(undefined)
      })
    },
  }
}
