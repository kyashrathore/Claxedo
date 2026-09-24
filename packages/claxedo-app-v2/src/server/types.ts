import type {
  AgentContentPart,
  AgentMessageInfo,
  AgentPermission,
  AgentPermissionReply,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentSnapshotFileDiff,
  AgentTodo,
  RuntimeGoalSnapshot,
} from "@claxedo/agent-runtime-contract"
import type { SolidQueryOptions } from "@tanstack/solid-query"
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

export type RetryAction = {
  readonly reason: string
  readonly provider: string
  readonly title: string
  readonly message: string
  readonly label: string
  readonly link?: string
}

export type SessionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "retrying"; readonly attempt: number; readonly message: string; readonly nextAt: number; readonly action?: RetryAction }
  | { readonly kind: "recovering"; readonly reason: "processRestart" | "uncertainExecution"; readonly message: string }
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
  | { readonly kind: "dismiss"; readonly request?: "permission" | "question" }

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

export type PromptDeliveryRequest = "queue" | "steer"

export type PromptDelivery = "start" | PromptDeliveryRequest

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
  readonly delivery?: PromptDeliveryRequest
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

export type SessionStatusReadFailure = { readonly placementId: PlacementId; readonly error: AppError }

export type SessionStatusRead = {
  readonly reports: readonly SessionStatusReport[]
  readonly unreported: SessionStatus
  readonly failures: readonly SessionStatusReadFailure[]
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
  readonly unavailableReason?: string
  readonly models: readonly ModelChoice[]
  readonly efforts: readonly string[]
  readonly permissionModes: readonly string[]
  readonly goalMode: "native" | "evaluated" | "none"
}

export type HarnessModel = {
  readonly model: ModelChoice
  readonly name: string
  readonly connected: boolean
  readonly efforts: readonly string[]
}

export type HarnessOptions = {
  readonly models: readonly HarnessModel[]
  readonly current?: ModelChoice
  readonly efforts: readonly string[]
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

export type FeatureAvailability =
  | { readonly kind: "available" }
  | { readonly kind: "unavailable"; readonly reason: string }

export type FetchQuery<T> = SolidQueryOptions<T, AppError, T, readonly unknown[]> & { readonly initialData?: undefined }
