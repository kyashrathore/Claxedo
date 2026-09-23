import type { PlacementId, ProjectId, RequestId, TerminalId } from "./ids"
import type {
  AgentRequest,
  FileDiff,
  SessionRef,
  SessionRow,
  SessionStatus,
  Terminal,
  TerminalAgentStatus,
  Todo,
  TranscriptMessage,
  TranscriptPart,
} from "./types"

export type ServerEvent =
  | { readonly type: "sessionUpserted"; readonly row: SessionRow }
  | { readonly type: "sessionRemoved"; readonly ref: SessionRef }
  | { readonly type: "statusChanged"; readonly ref: SessionRef; readonly status: SessionStatus }
  | { readonly type: "messageUpserted"; readonly ref: SessionRef; readonly message: TranscriptMessage }
  | { readonly type: "messageRemoved"; readonly ref: SessionRef; readonly messageId: string }
  | { readonly type: "partUpserted"; readonly ref: SessionRef; readonly part: TranscriptPart }
  | {
      readonly type: "partDelta"
      readonly ref: SessionRef
      readonly messageId: string
      readonly partId: string
      readonly field: string
      readonly delta: string
    }
  | { readonly type: "partRemoved"; readonly ref: SessionRef; readonly messageId: string; readonly partId: string }
  | { readonly type: "requestOpened"; readonly ref: SessionRef; readonly request: AgentRequest }
  | { readonly type: "requestClosed"; readonly ref: SessionRef; readonly requestId: RequestId }
  | { readonly type: "todosChanged"; readonly ref: SessionRef; readonly todos: readonly Todo[] }
  | { readonly type: "diffChanged"; readonly ref: SessionRef; readonly diff: readonly FileDiff[] }
  | { readonly type: "filesChanged"; readonly placementId: PlacementId }
  | { readonly type: "projectChanged"; readonly projectId: ProjectId }
  | { readonly type: "pluginsChanged" }
  | { readonly type: "streamGap"; readonly placementId?: PlacementId }
  | { readonly type: "terminalCreated"; readonly terminal: Terminal }
  | { readonly type: "terminalUpdated"; readonly terminal: Terminal }
  | { readonly type: "terminalExited"; readonly placementId: PlacementId; readonly terminalId: TerminalId; readonly code?: number }
  | { readonly type: "terminalRemoved"; readonly placementId: PlacementId; readonly terminalId: TerminalId }
  | {
      readonly type: "terminalAgentStatusChanged"
      readonly placementId: PlacementId
      readonly terminalId: TerminalId
      readonly status: TerminalAgentStatus
    }

export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "offline"; readonly reason: string }
