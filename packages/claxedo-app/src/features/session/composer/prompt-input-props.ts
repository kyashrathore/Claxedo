import type { Prompt } from "@/features/session/providers/prompt"
import type { FollowupDraft } from "@/features/session/composer/ui/submit"
import type { SessionStatusStage as SessionStatusStageValue } from "@/features/session/ui/components/session-status-stage"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { CloudLog } from "@/features/session/ui/components/cloud-startup-view"
import type { HarnessSelectionController, HarnessSubmitController } from "@/features/session/harness/controller"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { ComposerMode } from "./mode"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"

export type PromptRetryAction = (prompt?: Prompt) => unknown

export interface PromptInputProps {
  class?: string
  mode: ComposerMode
  variant?: "dock" | "new-session"
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  /** Git revision used when the draft provisions a new worktree or cloud workspace. */
  newSessionBaseRef?: string
  /** Source branch name used by cloud provisioning; distinct from a local remote-tracking ref. */
  newSessionSourceBranch?: string
  onNewSessionWorktreeChange?: (worktree: string) => void
  newSessionWorkspaceKind?: "local" | "cloud" | "user-hosted"
  onNewSessionWorktreeReset?: () => void
  onCloudStartup?: (state?: {
    open: boolean
    sync?: boolean
    id?: string
    status?: string
    err?: string
    logs?: CloudLog[]
  }) => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  /** Explicit session ID - bypasses route params for embedded contexts (e.g. page dock). */
  sessionID?: string
  /** Explicit directory for embedded contexts. */
  sessionDirectory?: string
  sessionRef?: () => SessionRef | undefined
  /** Stable draft identity for draft scopes that should survive later attachment. */
  draftId?: string
  /** When true, skip navigation after creating a new session. */
  navigateOnCreate?: boolean
  /** System prompt injected with every request. */
  system?: string
  /** Override agent name for this input. */
  agent?: string
  /** Whether a busy session can be stopped through the current transport. */
  canAbort?: () => boolean
  /**
   * Whether the current transport exposes a permission docking surface. Gates the
   * composer's approval control, and is the same capability the
   * `permissions.autoaccept` command gates on. Defaults to `true`.
   *
   * NOTE: every harness adapter shipped today reports `true` (acp/index.ts,
   * shared/sdk-runtime-adapter.ts, pi/index.ts, opencode/index.ts all declare
   * `permissions: true`) — an older comment in use-session-commands.tsx claiming
   * an ACP agent lacks a permission surface is stale. In practice this is false only
   * for the pending-harness placeholder while readiness is still polling.
   */
  canPrompt?: () => boolean
  /** Session status supplied by the session owner. Defaults to idle for embedded contexts. */
  status?: () => SessionStatus
  /** Active turn state supplied by the session owner. Defaults to status-only for embedded contexts. */
  activeTurn?: () => boolean
  goal?: () => RuntimeGoalSnapshot | null | undefined
  goalCapabilities?: () => AgentRuntimeGoalCapabilities | undefined
  stopGoal?: () => void | Promise<unknown>
  /** Registers the mounted composer's retry action for an in-timeline recovery surface. */
  registerRetry?: (retry?: PromptRetryAction) => void
  /** Signed workspace runtime identity for relay-backed session sends. */
  workspaceId?: () => string | undefined
  workspaceKind?: () => "cloud" | "user-hosted" | undefined
  harnessSubmitController?: HarnessSubmitController
  harnessSelectionController?: HarnessSelectionController
  /** Optimistic timeout stage supplied by the status dispatcher owner. */
  statusStage?: () => SessionStatusStageValue
  /** Review diff files supplied by the session owner for comment routing. */
  diffFiles?: () => readonly string[]
  signedControlPlane?: () => boolean
  /** When true, the input collapses to a single line when unfocused and expands on focus. Default: false. */
  collapsible?: boolean
}
