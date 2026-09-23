import type { AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import type { Prompt } from "@/features/session/providers/prompt"
import type { FollowupDraft } from "@/features/session/composer/ui/submit"
import type { SessionStatusStage as SessionStatusStageValue } from "@/features/session/ui/components/session-status-stage"
import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import type { CloudLog } from "@/features/session/ui/components/cloud-startup-view"
import type { HarnessSelectionController, HarnessSubmitController } from "@/features/session/harness/controller"
import type { SessionRef } from "@/platform/identity/session-ref"
import type { ComposerMode } from "./mode"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeGoalCapabilities } from "@/platform/runtime/agent/agent-runtime-client"
import type { RelayHostKind, WorkspaceHostKind } from "@/platform/runtime/placement-wire"

export type PromptRetryAction = (prompt?: Prompt) => unknown

export interface PromptInputProps {
  onSessionStart?: (draftId: string, binding: AgentSessionStartBinding | undefined, outcome?: "transport-failed") => void
  class?: string
  mode: ComposerMode
  variant?: "dock" | "new-session"
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  /** Git revision the draft's new worktree or provisioned workspace starts from. */
  newSessionBaseRef?: string
  /** Source branch name used by cloud provisioning; distinct from a local remote-tracking ref. */
  newSessionSourceBranch?: string
  onNewSessionWorktreeChange?: (worktree: string) => void
  newSessionHostKind?: WorkspaceHostKind
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
   * NOTE: every current connection/native adapter reports `true`; an older
   * comment in use-session-commands.tsx claiming
   * an ACP agent lacks a permission surface is stale. In practice this is false only
   * for the pending-harness placeholder while readiness is still polling.
   */
  canPrompt?: () => boolean
  /** Session status supplied by the session owner. Defaults to idle for embedded contexts. */
  status?: () => SessionStatus
  /** Whether the session owner has established the authoritative status. */
  statusReady?: () => boolean
  /** Active turn state supplied by the session owner. Defaults to status-only for embedded contexts. */
  activeTurn?: () => boolean
  goal?: () => RuntimeGoalSnapshot | null | undefined
  goalCapabilities?: () => AgentRuntimeGoalCapabilities | undefined
  /**
   * Forced re-read of the session's Goal state. The composer calls this when the
   * Goal toggle is pressed before the session owner's deferred hydration has
   * filled `goalCapabilities`, so arming never refuses on unknown capabilities.
   */
  refreshGoal?: (opts?: { force?: boolean }) => Promise<boolean>
  stopGoal?: () => void | Promise<unknown>
  /** Registers the mounted composer's retry action for an in-timeline recovery surface. */
  registerRetry?: (retry?: PromptRetryAction) => void
  /**
   * Whether the session authority admits this reader's prompt, as the session's
   * own transport capabilities report it. A draft names no session and has
   * none, so the composer asks the workspace role instead.
   */
  sessionPromptAdmitted?: () => boolean | undefined
  /** Signed workspace runtime identity for relay-backed session sends. */
  workspaceId?: () => string | undefined
  hostKind?: () => RelayHostKind | undefined
  harnessSubmitController?: HarnessSubmitController
  harnessSelectionController?: HarnessSelectionController
  /** Optimistic timeout stage supplied by the status dispatcher owner. */
  statusStage?: () => SessionStatusStageValue
  /** Review diff files supplied by the session owner for comment routing. */
  diffFiles?: () => readonly string[]
  signedControlPlane?: () => boolean
  /** Fold the idle composer to one row (`+`, permissions, editor, model, send); editor focus or any draft content expands it. See `composerCollapsed`. */
  collapsible?: boolean
}
