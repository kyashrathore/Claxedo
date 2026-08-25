import { createSignal } from "solid-js"

export type ReviewWorkspaceActiveTab =
  | { kind: "review"; label: string }
  | { kind: "file"; label: string; path: string }
  | { kind: "browser"; label: string }
  | { kind: "context"; label: string }
  | { kind: "process"; label: string }

const [activeTab, setActiveTabInternal] = createSignal<ReviewWorkspaceActiveTab | undefined>()

export const reviewWorkspaceActiveTab = activeTab

/**
 * The last published tab, held outside the reactive graph. `setReviewWorkspaceActiveTab`
 * is the signal's only writer, so this mirror is always the signal's current
 * value — and the write guard below can compare against it without READING the
 * signal.
 *
 * That distinction is the whole point. Publishers call the setter from an
 * effect, so a tracked read inside the guard subscribed every publisher to its
 * own writes. The workspace panel retains a recently-visited body beside the
 * displayed one, which makes two live publishers: each one's write re-ran the
 * other, which republished its own different tab, which re-ran the first. The
 * loop had no fixed point, so `runUpdates`/`completeUpdates` nested one level
 * per generation until a cross-workspace session switch died with
 * `RangeError: Maximum call stack size exceeded` (observed 3126 generations
 * deep). Comparing against the mirror leaves each body publishing only when
 * ITS OWN tab state changes.
 */
let publishedTab: ReviewWorkspaceActiveTab | undefined

function sameActiveTab(left: ReviewWorkspaceActiveTab | undefined, right: ReviewWorkspaceActiveTab | undefined) {
  if (!left || !right) return left === right
  if (left.kind !== right.kind || left.label !== right.label) return false
  if (left.kind === "file" && right.kind === "file") return left.path === right.path
  return true
}

export function setReviewWorkspaceActiveTab(tab: ReviewWorkspaceActiveTab | undefined): void {
  if (sameActiveTab(publishedTab, tab)) return
  publishedTab = tab
  setActiveTabInternal(tab)
}
