import type {
  RunID,
  StreamID,
  WorkGraphContext,
  WorkItemID,
} from "../contracts"
import type { ExecutionSessionID, StreamEnvelopeID } from "./workspace-execution"

export type ReconcilableRun = Readonly<{
  runId: RunID
  streamId: StreamID
  workItemId: WorkItemID
  sessionId: ExecutionSessionID
  envelopeId: StreamEnvelopeID
  childIsolationId: string | null
  profileJson: string
  leaseEpoch: number
  leaseExpiresAt: number
}>

export type RunLeaseRenewal = Readonly<{
  leaseEpoch: number
  expiresAt: number
  recovered: boolean
}>

type RunTerminalIdentity = Readonly<{
  runId: RunID
  workItemId: WorkItemID
  leaseEpoch: number
}>

export type RunTerminalResult =
  | Readonly<RunTerminalIdentity & {
      state: "result"
      /** Persistence rejects empty or whitespace-only semantic output. */
      summary: string
      artifacts: readonly string[]
    }>
  | Readonly<RunTerminalIdentity & { state: "failed"; reason: string }>
  | Readonly<RunTerminalIdentity & { state: "cancelled"; reason?: string }>

/** Runtime ownership remains separate from atomic Run admission. */
export type RunRuntimePort = Readonly<{
  listReconcilable: (context: WorkGraphContext) => Promise<readonly ReconcilableRun[]>
  renewLease: (
    context: WorkGraphContext,
    input: Readonly<{
      runId: RunID
      expectedLeaseEpoch: number
      occurredAt: number
      durationMs: number
    }>,
  ) => Promise<RunLeaseRenewal | undefined>
  recordResult: (context: WorkGraphContext, input: RunTerminalResult) => Promise<boolean>
}>
