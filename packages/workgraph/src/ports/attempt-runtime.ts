import type {
  AttemptID,
  StreamID,
  WorkGraphContext,
  WorkItemID,
} from "../contracts"
import type { ExecutionSessionID, StreamEnvelopeID } from "./workspace-execution"

export type ReconcilableAttempt = Readonly<{
  attemptId: AttemptID
  streamId: StreamID
  workItemId: WorkItemID
  sessionId: ExecutionSessionID
  envelopeId: StreamEnvelopeID
  childIsolationId: string | null
  profileJson: string
  leaseEpoch: number
  leaseExpiresAt: number
}>

export type AttemptLeaseRenewal = Readonly<{
  leaseEpoch: number
  expiresAt: number
  recovered: boolean
}>

type AttemptTerminalIdentity = Readonly<{
  attemptId: AttemptID
  workItemId: WorkItemID
  leaseEpoch: number
}>

export type AttemptTerminalResult =
  | Readonly<AttemptTerminalIdentity & {
      state: "result"
      /** Persistence rejects empty or whitespace-only semantic output. */
      summary: string
      artifacts: readonly string[]
    }>
  | Readonly<AttemptTerminalIdentity & { state: "failed"; reason: string }>
  | Readonly<AttemptTerminalIdentity & { state: "cancelled"; reason?: string }>

/** Runtime ownership remains separate from atomic Attempt admission. */
export type AttemptRuntimePort = Readonly<{
  listReconcilable: (context: WorkGraphContext) => Promise<readonly ReconcilableAttempt[]>
  renewLease: (
    context: WorkGraphContext,
    input: Readonly<{
      attemptId: AttemptID
      expectedLeaseEpoch: number
      occurredAt: number
      durationMs: number
    }>,
  ) => Promise<AttemptLeaseRenewal | undefined>
  recordResult: (context: WorkGraphContext, input: AttemptTerminalResult) => Promise<boolean>
}>
