import { createSignal } from "solid-js"

export type ReviewWorkspaceActiveTab =
  | { kind: "review"; label: string }
  | { kind: "file"; label: string; path: string }
  | { kind: "browser"; label: string }
  | { kind: "context"; label: string }
  | { kind: "process"; label: string }

const [activeTab, setActiveTabInternal] = createSignal<ReviewWorkspaceActiveTab | undefined>()

export const reviewWorkspaceActiveTab = activeTab

function sameActiveTab(left: ReviewWorkspaceActiveTab | undefined, right: ReviewWorkspaceActiveTab | undefined) {
  if (!left || !right) return left === right
  if (left.kind !== right.kind || left.label !== right.label) return false
  if (left.kind === "file" && right.kind === "file") return left.path === right.path
  return true
}

export function setReviewWorkspaceActiveTab(tab: ReviewWorkspaceActiveTab | undefined): void {
  if (sameActiveTab(activeTab(), tab)) return
  setActiveTabInternal(tab)
}
