import type {
  AgentContentPart,
  AgentFileContent,
  AgentMessageInfo,
  AgentPermission,
  AgentPermissionReply,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentSnapshotFileDiff,
  AgentTodo,
  RuntimeGoalSnapshot,
} from "@claxedo/agent-runtime-contract"
import type { TerminalCheckpoint } from "@claxedo/workspace-runtime/client"
import type { SolidQueryOptions } from "@tanstack/solid-query"
import type { MachineId, OrgId, PlacementId, ProjectId, RequestId, SessionId, TerminalId, UserId } from "./ids"

export type ErrorClass = "auth" | "rate_limit" | "network" | "not_found" | "conflict" | "invalid" | "internal"

export type AppError = {
  readonly class: ErrorClass
  readonly message: string
  readonly retryable: boolean
  readonly status?: number
  readonly code?: string
  readonly cause?: unknown
}

export type SessionRef = {
  readonly projectId: ProjectId
  readonly placementId: PlacementId
  readonly sessionId: SessionId
}

export type Machine = {
  readonly id: MachineId
  readonly name: string
  readonly ownerId?: UserId
  readonly online: boolean
  readonly isThisMachine: boolean
}

export type PlacementKind = "folder" | "worktree" | "cloud"

export type Placement = {
  readonly id: PlacementId
  readonly projectId: ProjectId
  readonly kind: PlacementKind
  readonly label: string
  readonly path?: string
  readonly branch?: string
  readonly machineId?: MachineId
}

export type ProjectSource =
  | { readonly kind: "repository"; readonly url: string }
  | { readonly kind: "connectedRepository"; readonly connectionId: string; readonly fullName: string }
  | { readonly kind: "folder"; readonly path: string }

export type Project = {
  readonly id: ProjectId
  readonly name: string
  readonly source?: ProjectSource
  readonly env: Readonly<Record<string, string>>
  readonly createdAt: number
  readonly updatedAt: number
}

export type SessionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "retrying"; readonly attempt: number; readonly message: string; readonly nextAt: number }
  | { readonly kind: "recovering"; readonly message: string }
  | { readonly kind: "failed"; readonly error: AppError }

export type SessionRow = {
  readonly ref: SessionRef
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastHumanTurnAt?: number
  readonly archivedAt?: number
  readonly parentSessionId?: SessionId
  readonly harness?: string
}

export type TranscriptMessage = AgentMessageInfo
export type TranscriptPart = AgentContentPart
export type TranscriptEntry = { readonly info: TranscriptMessage; readonly parts: readonly TranscriptPart[] }

export type AgentRequest =
  | { readonly kind: "permission"; readonly id: RequestId; readonly permission: AgentPermission }
  | { readonly kind: "question"; readonly id: RequestId; readonly question: AgentQuestion }

export type AgentRequestReply =
  | { readonly kind: "permission"; readonly reply: AgentPermissionReply }
  | { readonly kind: "question"; readonly answers: readonly AgentQuestionAnswer[] }
  | { readonly kind: "dismiss" }

export type Todo = AgentTodo
export type FileDiff = AgentSnapshotFileDiff

export type SessionPage = { readonly rows: readonly SessionRow[]; readonly nextCursor?: string }

export type TranscriptPage = { readonly entries: readonly TranscriptEntry[]; readonly olderCursor?: string }

export type SessionGoal = RuntimeGoalSnapshot

export type GoalAction = "pause" | "resume" | "remove"

export type SessionGoalState = {
  readonly goal: SessionGoal | undefined
  readonly actions: readonly GoalAction[]
}

export type SessionSnapshot = {
  readonly row: SessionRow
  readonly status: SessionStatus
  readonly transcript: TranscriptPage
  readonly requests: readonly AgentRequest[]
  readonly todos: readonly Todo[]
  readonly diff: readonly FileDiff[]
  readonly goal: SessionGoalState
}

export type ModelChoice = { readonly providerId: string; readonly modelId: string; readonly variant?: string }

export type PromptAttachment =
  | { readonly kind: "file"; readonly path: string; readonly mime?: string }
  | { readonly kind: "image"; readonly dataUrl: string; readonly name?: string; readonly mime: string }
  | { readonly kind: "text"; readonly text: string; readonly label?: string }

export type PromptInput = {
  readonly clientRequestId: string
  readonly messageId?: string
  readonly text: string
  readonly attachments: readonly PromptAttachment[]
  readonly agent?: string
  readonly model?: ModelChoice
  readonly effort?: string
  readonly permissionMode?: string
  readonly goal?: { readonly objective: string }
}

export type SessionCreateInput = {
  readonly placementId: PlacementId
  readonly harness?: string
  readonly model?: ModelChoice
  readonly title?: string
}

export type SessionStatusReport = {
  readonly ref: SessionRef
  readonly status: SessionStatus
  readonly requests: readonly AgentRequest[]
}

export type SessionStatusRead = {
  readonly reports: readonly SessionStatusReport[]
  readonly unreported: SessionStatus
}

export type QueuedPromptPart = { readonly type: string; readonly text?: string; readonly filename?: string }

export type QueuedPromptSteering = {
  readonly mode: "start" | "steer"
  readonly operationId: string
  readonly state: "dispatching" | "accepted" | "unknown" | "rejected"
  readonly message?: string
}

export type QueuedPrompt = {
  readonly seq: number
  readonly messageId?: string
  readonly queuedAt: number
  readonly parts: readonly QueuedPromptPart[]
  readonly held: boolean
  readonly steering?: QueuedPromptSteering
}

export type QueuedPromptAction = "cancel" | "steer" | "hold" | "release"

export type QueuedPromptControl = {
  readonly ok: boolean
  readonly status?: "pending" | "unknown"
  readonly message?: string
}

export type OrgRole = "owner" | "admin" | "member"

export type Principal =
  | { readonly kind: "machine"; readonly machineId: MachineId }
  | {
      readonly kind: "user"
      readonly userId: UserId
      readonly name: string
      readonly email?: string
      readonly orgId?: OrgId
      readonly orgRole?: OrgRole
    }

export type HarnessInfo = {
  readonly id: string
  readonly name: string
  readonly available: boolean
  readonly models: readonly ModelChoice[]
  readonly efforts: readonly string[]
  readonly permissionModes: readonly string[]
  readonly goalMode: "native" | "evaluated" | "none"
}

export type Capabilities = {
  readonly principal: Principal
  readonly signedIn: boolean
  readonly thisMachine?: Machine
  readonly harnesses: readonly HarnessInfo[]
  readonly features: {
    readonly tasks: boolean
    readonly documents: boolean
    readonly cloud: boolean
    readonly remoteAccess: boolean
    readonly marketplace: boolean
    readonly terminals: boolean
    readonly browser: boolean
    readonly sharing: boolean
    readonly livePlugins: boolean
  }
}

export type FetchQuery<T> = SolidQueryOptions<T, AppError, T, readonly unknown[]> & { readonly initialData?: undefined }

export type Terminal = {
  readonly id: TerminalId
  readonly placementId: PlacementId
  readonly title: string
  readonly cwd?: string
  readonly sessionId?: SessionId
  readonly command?: string
  readonly createRequestId?: string
}

export type TerminalCreateInput = {
  readonly placementId: PlacementId
  readonly title: string
  readonly command?: string
  readonly sessionId?: SessionId
  readonly previousTerminalId?: TerminalId
  readonly createRequestId: string
}

export type TerminalSize = { readonly cols: number; readonly rows: number }

export type TerminalUpdateInput = { readonly title?: string; readonly size?: TerminalSize }

export type TerminalPresence = "live" | "gone" | "unreachable"

export type TerminalAgentStatus = "working" | "idle" | "waitingOnUser" | "failed"

export type TerminalFrame =
  | { readonly kind: "output"; readonly data: string }
  | { readonly kind: "cursor"; readonly cursor: number; readonly checkpoint?: TerminalCheckpoint }

export type TerminalStreamClose = { readonly code: number; readonly reason: string }

export type TerminalStream = {
  readonly send: (data: string) => void
  readonly close: () => void
}

export type TerminalAttachInput = {
  readonly placementId: PlacementId
  readonly terminalId: TerminalId
  readonly cursor: number
  readonly onOpen: () => void
  readonly onFrame: (frame: TerminalFrame) => void
  readonly onClose: (close: TerminalStreamClose) => void
}

export type FileNode = {
  readonly name: string
  readonly path: string
  readonly kind: "file" | "directory"
  readonly ignored: boolean
}

export type FileContent = AgentFileContent

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted"

export type FileChange = {
  readonly path: string
  readonly status: ChangeStatus
  readonly additions: number
  readonly deletions: number
  readonly from?: string
}

export type GitStatus = {
  readonly branch?: string
  readonly upstream?: string
  readonly ahead: number
  readonly behind: number
  readonly staged: readonly FileChange[]
  readonly unstaged: readonly FileChange[]
}

export type GitCommit = {
  readonly hash: string
  readonly shortHash: string
  readonly subject: string
  readonly author: string
  readonly date: string
  readonly refs: readonly string[]
  readonly parents: readonly string[]
}

export type GitRefs = {
  readonly branches: readonly string[]
  readonly tags: readonly string[]
  readonly recent: readonly { readonly hash: string; readonly subject: string }[]
}

export type GitBases = { readonly defaultRef?: string; readonly candidates: readonly string[] }

export type DiffScope =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "staged" }
  | { readonly kind: "unstaged" }
  | { readonly kind: "branch"; readonly base: string }
  | { readonly kind: "branchWorktree"; readonly base: string }
  | { readonly kind: "range"; readonly from: string; readonly to: string }

export type DiffStatus = "added" | "deleted" | "modified"

export type DiffSummary = {
  readonly file: string
  readonly status?: DiffStatus
  readonly additions: number
  readonly deletions: number
  readonly from?: string
}

export type DiffFile = DiffSummary & {
  readonly patch?: string
  readonly before?: string
  readonly after?: string
}

export type GitCommitInput = { readonly message: string; readonly amend?: boolean }

export type GitPushInput = { readonly setUpstream?: boolean }

export type GitPushResult = { readonly remote: string; readonly branch: string }

export type WorktreeCreateInput = { readonly name?: string; readonly baseRef?: string }
