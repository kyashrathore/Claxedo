import type { TerminalCheckpoint } from "@claxedo/workspace-runtime/client"
import type { PlacementId, SessionId, TerminalId } from "./ids"

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
