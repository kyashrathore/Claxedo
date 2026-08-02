import type {
  RunID,
  ConnectionID,
  ExecutionEnvironment,
  RepositoryTarget,
  ResolvedExecutionProfile,
  StreamID,
  WorkGraphContext,
  WorkItemID,
} from "../contracts"

declare const runtimeIdentity: unique symbol
type RuntimeIdentity<Name extends string> = string & { readonly [runtimeIdentity]: Name }

export type StreamEnvelopeID = RuntimeIdentity<"StreamEnvelopeID">
export type ChildIsolationID = RuntimeIdentity<"ChildIsolationID">
export type ExecutionSessionID = RuntimeIdentity<"ExecutionSessionID">

export function childIsolationIdForRun(runId: RunID): ChildIsolationID {
  return runId as unknown as ChildIsolationID
}

export type StreamEnvelope = Readonly<{
  id: StreamEnvelopeID
  streamId: StreamID
  environment: ExecutionEnvironment
  repository?: RepositoryTarget
  workspaceId: string
}>

export type ExecutionLaunch = Readonly<{
  sessionId: ExecutionSessionID
  envelopeId: StreamEnvelopeID
  childIsolationId?: ChildIsolationID
  /** Stable project identity used to open and bind the Session transcript. */
  projectId: string
}>

export type ExecutionResult =
  | Readonly<{ state: "pending" | "running" }>
  | Readonly<{ state: "parked"; message: string }>
  | Readonly<{ state: "succeeded"; summary: string; artifacts: readonly string[] }>
  | Readonly<{ state: "failed"; message: string }>
  | Readonly<{ state: "cancelled" }>

export type LandingReceipt = Readonly<{
  beforeHead: string
  afterHead: string
  diffRef: string
}>

export type WorkspaceExecutionPort = Readonly<{
  provisionOrAdopt(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      parentStreamId?: StreamID
      environment: ExecutionEnvironment
      repository?: RepositoryTarget
      envelopeId?: StreamEnvelopeID
    }>,
  ): Promise<StreamEnvelope>

  launch(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      workItemId: WorkItemID
      title: string
      runId: RunID
      leaseEpoch: number
      envelopeId: StreamEnvelopeID
      workspaceId: string
      childIsolationId?: ChildIsolationID
      prompt: string
      profile: ResolvedExecutionProfile
      connectionIds: readonly ConnectionID[]
    }>,
  ): Promise<ExecutionLaunch>

  /** Cancellation is retried from durable compensation state and must be idempotent. */
  cancel(
    context: WorkGraphContext,
    input: Readonly<{
      runId: RunID
      sessionId: ExecutionSessionID
      reason: string
    }>,
  ): Promise<void>

  result(
    context: WorkGraphContext,
    input: Readonly<{
      runId: RunID
      sessionId: ExecutionSessionID
    }>,
  ): Promise<ExecutionResult>

  /** Revalidates and serially lands a candidate revision into the Stream envelope. */
  land?(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      candidateRevision: string
      expectedHead: string
      forbiddenPatterns?: readonly string[]
    }>,
  ): Promise<LandingReceipt>

  /**
   * Cleanup is idempotent. Reconciliation targets only the supplied legacy
   * child IDs; Stream workspace removal belongs to delete/replace lifecycle.
   */
  cleanup(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      envelopeId: StreamEnvelopeID
      childIsolationIds?: readonly ChildIsolationID[]
      reason: "delete" | "replace" | "reconcile"
    }>,
  ): Promise<void>
}>
