import type { SessionLastTurn } from "@claxedo/agent-runtime-contract"
import type { PlacementId, ProjectId, RequestId, TerminalId } from "./ids"
import type { CloudWorkspaceStatus } from "./cloud-types"
import type { HarnessConnectionState, HarnessHealth } from "./harness-types"
import type { Terminal, TerminalAgentStatus } from "./terminal-types"
import type { BackgroundWork, SessionStatus } from "./status-types"
import type { AgentRequest, FileDiff, SessionGoal, SessionLocation, SessionRow, Subagent, Todo, TranscriptMessage, TranscriptPart } from "./types"

export type PartAddress = { readonly messageId: string; readonly partId: string }

export type ServerEvent =
  | { readonly type: "sessionUpserted"; readonly row: SessionRow }
  | { readonly type: "sessionRemoved"; readonly ref: SessionLocation }
  | {
      readonly type: "statusChanged"
      readonly ref: SessionLocation
      readonly status: SessionStatus
      readonly lastTurn?: SessionLastTurn
      readonly waitingOnUser?: boolean
      readonly backgroundWork?: BackgroundWork
      readonly replayed?: boolean
    }
  | { readonly type: "backgroundWorkChanged"; readonly ref: SessionLocation; readonly work: BackgroundWork }
  | { readonly type: "messageUpserted"; readonly ref: SessionLocation; readonly message: TranscriptMessage }
  | { readonly type: "messageRemoved"; readonly ref: SessionLocation; readonly messageId: string }
  | { readonly type: "partUpserted"; readonly ref: SessionLocation; readonly part: TranscriptPart }
  | {
      readonly type: "partDelta"
      readonly ref: SessionLocation
      readonly messageId: string
      readonly partId: string
      readonly field: string
      readonly delta: string
    }
  | { readonly type: "partRemoved"; readonly ref: SessionLocation; readonly messageId: string; readonly partId: string }
  | { readonly type: "partsRetracted"; readonly ref: SessionLocation; readonly reason: string; readonly parts: readonly PartAddress[] }
  | { readonly type: "requestOpened"; readonly ref: SessionLocation; readonly request: AgentRequest }
  | { readonly type: "requestClosed"; readonly ref: SessionLocation; readonly requestId: RequestId }
  | { readonly type: "todosChanged"; readonly ref: SessionLocation; readonly todos: readonly Todo[] }
  | { readonly type: "diffChanged"; readonly ref: SessionLocation; readonly diff: readonly FileDiff[] }
  | { readonly type: "goalChanged"; readonly ref: SessionLocation; readonly goal: SessionGoal | undefined }
  | { readonly type: "subagentUpdated"; readonly ref: SessionLocation; readonly subagent: Subagent }
  | {
      readonly type: "harnessHealthChanged"
      readonly ref: SessionLocation
      readonly health: HarnessHealth
      readonly connectionState?: HarnessConnectionState
    }
  | { readonly type: "filesChanged"; readonly placementId: PlacementId }
  | { readonly type: "projectChanged"; readonly projectId: ProjectId }
  | { readonly type: "pluginsChanged" }
  | { readonly type: "streamGap"; readonly placementId?: PlacementId }
  | { readonly type: "sessionsChanged"; readonly placementId?: PlacementId }
  | { readonly type: "placementsChanged" }
  | { readonly type: "usageChanged" }
  | { readonly type: "cloudWorkspaceChanged"; readonly workspaceId: PlacementId; readonly status: CloudWorkspaceStatus }
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
  | { readonly kind: "reconnecting"; readonly attempt: number; readonly afterLive: boolean }
  | { readonly kind: "offline"; readonly reason: string }
