import type {
  AttemptID,
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
  /** Stable project identity used to open and bind the Session transcript. */
  projectId: string
}>

export type ExecutionResult =
  | Readonly<{ state: "pending" | "running" }>
  | Readonly<{ state: "succeeded"; summary: string; artifacts: readonly string[] }>
  | Readonly<{ state: "failed"; message: string }>
  | Readonly<{ state: "cancelled" }>

export type WorkspaceExecutionPort = Readonly<{
  provisionOrAdopt(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
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
      attemptId: AttemptID
      leaseEpoch: number
      envelopeId: StreamEnvelopeID
      workspaceId: string
      prompt: string
      profile: ResolvedExecutionProfile
      connectionIds: readonly ConnectionID[]
    }>,
  ): Promise<ExecutionLaunch>

  /** Cancellation is retried from durable compensation state and must be idempotent. */
  cancel(
    context: WorkGraphContext,
    input: Readonly<{
      attemptId: AttemptID
      sessionId: ExecutionSessionID
      reason: string
    }>,
  ): Promise<void>

  result(
    context: WorkGraphContext,
    input: Readonly<{
      attemptId: AttemptID
      sessionId: ExecutionSessionID
    }>,
  ): Promise<ExecutionResult>

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
