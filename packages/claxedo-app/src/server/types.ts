import type {
  AgentContentPart,
  AgentMessageInfo,
  AgentPermission,
  AgentPermissionReply,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentSnapshotFileDiff,
  AgentSubagentUpdate,
  AgentTodo,
  AgentTurnOutcome,
  SessionLastTurn,
  PromptDeliveryRequest,
  RuntimeGoalSnapshot,
} from "@claxedo/agent-runtime-contract"
import type { BackgroundWork, ListedStatus, SessionStatus } from "./status-types"
import type { SolidQueryOptions } from "@tanstack/solid-query"
import type { HarnessSelection } from "../lib/harness-selection"
import type { MachineId, OrgId, PlacementId, ProjectId, RequestId, SessionId, UserId } from "./ids"

export type ErrorClass = "auth" | "rate_limit" | "network" | "not_found" | "conflict" | "invalid" | "internal"

export type AppError = {
  readonly class: ErrorClass
  readonly message: string
  readonly retryable: boolean
  readonly status?: number
  readonly code?: string
  readonly cause?: unknown
}

export type SessionLocation = {
  readonly projectId: ProjectId
  readonly placementId: PlacementId
  readonly sessionId: SessionId
}

export type SharedSessionRow = {
  readonly ref: SessionLocation
  readonly title: string | null
  readonly ownerName: string | null
  readonly level: "follow" | "send"
}

export type Machine = {
  readonly id: MachineId
  readonly name: string
  readonly ownerId?: UserId
  readonly online: boolean
  readonly isThisMachine: boolean
  readonly enrolled: boolean
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
  readonly gitRemote?: string
  readonly reachable: boolean
}

export type ProjectSource =
  | { readonly kind: "repository"; readonly url: string }
  | { readonly kind: "connectedRepository"; readonly connectionId: string; readonly fullName: string }
  | { readonly kind: "folder"; readonly path: string }

export type ProjectIcon = { readonly override?: string; readonly color?: string }

export type ProjectCommands = { readonly start?: string }

export type Project = {
  readonly id: ProjectId
  readonly name: string
  readonly source?: ProjectSource
  readonly directory?: string
  readonly icon?: ProjectIcon
  readonly commands?: ProjectCommands
  readonly available: boolean
  readonly missingCheckout?: MissingCheckout
  readonly env: Readonly<Record<string, string>>
  readonly createdAt: number
  readonly updatedAt: number
}

export type MissingCheckout = { readonly directory: string; readonly remote?: string }

export type ProjectUpdate = {
  readonly name?: string
  readonly env?: Readonly<Record<string, string>>
  readonly icon?: ProjectIcon
  readonly commands?: ProjectCommands
}

export type SessionSelections = {
  readonly harness?: HarnessSelection
  readonly model?: ModelChoice
  readonly permissionMode?: string
  readonly permissionModeLabel?: string
}

export type SessionRow = SessionSelections & {
  readonly ref: SessionLocation
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly lastHumanTurnAt?: number
  readonly archivedAt?: number
  readonly parentSessionId?: SessionId
  readonly lastTurn?: AgentTurnOutcome | SessionLastTurn
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
export type Subagent = AgentSubagentUpdate

export type SessionReader = { readonly seenAt?: number; readonly settledAt?: number }

export type SettledFilter = "active" | "all"

export type SessionListInput = { readonly projectId: ProjectId; readonly after?: string; readonly limit: number; readonly settled: SettledFilter }

export type SessionPage = {
  readonly rows: readonly SessionRow[]
  readonly statuses: ReadonlyMap<SessionId, ListedStatus>
  readonly readers: ReadonlyMap<SessionId, SessionReader>
  readonly nextAfter?: string
  readonly degraded?: boolean
}

export type TranscriptPage = { readonly entries: readonly TranscriptEntry[]; readonly olderCursor?: string }

export type OutlineTurn = {
  readonly id: string
  readonly createdAt: number
  readonly title?: string
  readonly preview: { readonly user?: string }
}

export type SessionOutline = { readonly turns: readonly OutlineTurn[]; readonly complete: boolean }

export type HeldSessionReads = { readonly latestTurn: TranscriptPage; readonly outline: SessionOutline | undefined }

export type ReaderSettings = { readonly reasoning: boolean; readonly shell: boolean; readonly edit: boolean }

export type PageShape = ReaderSettings & { readonly rows: number; readonly cols: number }

export type SessionGoal = RuntimeGoalSnapshot

export type GoalAction = "pause" | "resume" | "remove" | "stop"

export type SessionGoalState = {
  readonly goal: SessionGoal | undefined
  readonly actions: readonly GoalAction[]
  readonly available: boolean
}

export type SessionFirstRead = {
  readonly row: SessionRow
  readonly diff: readonly FileDiff[]
  readonly outline: SessionOutline | undefined
  readonly transcript: TranscriptPage
  readonly latestTurn: TranscriptPage | undefined
}

export type SessionReads = {
  readonly first: Promise<SessionFirstRead>
  readonly status: Promise<SessionStatus>
  readonly backgroundWork: Promise<BackgroundWork>
  readonly requests: Promise<readonly AgentRequest[]>
  readonly todos: Promise<readonly Todo[]>
  readonly goal: Promise<SessionGoalState>
  readonly subagents: Promise<readonly Subagent[]>
}

export type ModelChoice = { readonly providerId: string; readonly modelId: string; readonly variant?: string }

export type PromptAttachment =
  | { readonly kind: "file"; readonly path: string; readonly mime?: string }
  | { readonly kind: "image"; readonly dataUrl: string; readonly name?: string; readonly mime: string }
  | { readonly kind: "text"; readonly text: string; readonly label?: string }

export type { PromptDelivery, PromptDeliveryRequest } from "@claxedo/agent-runtime-contract"

export type PromptInput = {
  readonly clientRequestId: string
  readonly messageId?: string
  readonly text: string
  readonly attachments: readonly PromptAttachment[]
  readonly agent?: string
  readonly model?: ModelChoice
  readonly effort?: string
  readonly permissionMode?: string
  readonly serviceTier?: string
  readonly goal?: { readonly objective: string }
  readonly delivery?: PromptDeliveryRequest
}

export type SessionCreateInput = {
  readonly placementId: PlacementId
  readonly harness?: string
  readonly model?: ModelChoice
  readonly title?: string
  readonly prompt?: PromptInput & { readonly messageId: string }
}

export type QueuedPromptPart = { readonly type: string; readonly text?: string; readonly synthetic?: boolean; readonly filename?: string; readonly url?: string; readonly mime?: string }

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
  readonly unavailableReason?: string
  readonly models: readonly ModelChoice[]
  readonly efforts: readonly string[]
  readonly goalMode: "native" | "evaluated" | "none"
}

export type Capabilities = {
  readonly principal: Principal
  readonly signedIn: boolean
  readonly thisMachine?: Machine
  readonly harnesses: readonly HarnessInfo[]
  readonly features: {
    readonly documents: boolean
    readonly connections: boolean
    readonly cloud: boolean
    readonly remoteAccess: boolean
    readonly marketplace: boolean
    readonly terminals: boolean
    readonly browser: boolean
    readonly sharing: boolean
    readonly livePlugins: boolean
  }
}

export type FeatureAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string }

export type FetchQuery<T> = SolidQueryOptions<T, AppError, T, readonly unknown[]> & { readonly initialData?: undefined }
