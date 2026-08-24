import type { ReviewMode } from "@/features/review/review-intent"
import type { ReviewWorkspaceWorkingSetSnapshot } from "./review-workspace-working-set"

export type ReviewWorkspaceProps = {
  sessionId: string
  directory: string
  mode: ReviewMode
  fromRef?: string
  toRef?: string
  focusPath?: string
  focusVersion?: number
  focusFileIntent?: "tab" | "review"
  focusLine?: number
  focusProcessId?: string
  focusProcessVersion?: number
  focusContextSessionId?: string
  focusContextVersion?: number
  focusBrowserUrl?: string
  focusBrowserVersion?: number
  leafId?: string
  surfaceId?: string
  class?: string
  active?: boolean
  initialWorkingSet?: ReviewWorkspaceWorkingSetSnapshot
  onWorkingSetChange?: (snapshot: ReviewWorkspaceWorkingSetSnapshot) => void
}
