import type {
  AgentContentPart,
  AgentMessageInfo,
  AgentPermission,
  AgentPermissionReply,
  AgentQuestion,
  AgentQuestionAnswer,
  AgentSnapshotFileDiff,
  AgentTodo,
} from "@claxedo/agent-runtime-contract"
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
  | { readonly kind: "dismiss"; readonly request?: "permission" | "question" }

export type Todo = AgentTodo
export type FileDiff = AgentSnapshotFileDiff

export type SessionPage = { readonly rows: readonly SessionRow[]; readonly nextCursor?: string }

export type TranscriptPage = { readonly entries: readonly TranscriptEntry[]; readonly olderCursor?: string }

export type SessionSnapshot = {
  readonly row: SessionRow
  readonly status: SessionStatus
  readonly transcript: TranscriptPage
  readonly requests: readonly AgentRequest[]
  readonly todos: readonly Todo[]
  readonly diff: readonly FileDiff[]
}

export type ModelChoice = { readonly providerId: string; readonly modelId: string; readonly variant?: string }

export type PromptAttachment =
  | { readonly kind: "file"; readonly path: string; readonly mime?: string }
  | { readonly kind: "image"; readonly dataUrl: string; readonly name?: string; readonly mime: string }
  | { readonly kind: "text"; readonly text: string; readonly label?: string }

export type PromptInput = {
  readonly clientRequestId: string
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
