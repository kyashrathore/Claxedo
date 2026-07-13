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

export type ChildIsolation = Readonly<{
  id: ChildIsolationID
  envelopeId: StreamEnvelopeID
  workItemId: WorkItemID
  workspaceId: string
}>

export type ExecutionLaunch = Readonly<{
  sessionId: ExecutionSessionID
  envelopeId: StreamEnvelopeID
  childIsolationId?: ChildIsolationID
}>

export type ExecutionResult =
  | Readonly<{ state: "pending" | "running" }>
  | Readonly<{ state: "succeeded"; summary: string; artifacts: readonly string[] }>
  | Readonly<{ state: "failed"; message: string }>
  | Readonly<{ state: "cancelled" }>

export type IntegratedExecutionResult = Readonly<{
  summary: string
  artifacts: readonly string[]
}>

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

  createChildIsolation(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      envelopeId: StreamEnvelopeID
      workItemId: WorkItemID
      attemptId: AttemptID
    }>,
  ): Promise<ChildIsolation>

  launch(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      workItemId: WorkItemID
      attemptId: AttemptID
      envelopeId: StreamEnvelopeID
      childIsolationId?: ChildIsolationID
      prompt: string
      profile: ResolvedExecutionProfile
      connectionIds: readonly ConnectionID[]
    }>,
  ): Promise<ExecutionLaunch>

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
   * Applies the Attempt's configured integration policy after execution has
   * produced a semantic success and before WorkGraph records result_ready.
   * Implementations must be idempotent for an Attempt ID.
   */
  integrateResult(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      workItemId: WorkItemID
      attemptId: AttemptID
      sessionId: ExecutionSessionID
      envelopeId: StreamEnvelopeID
      childIsolationId?: ChildIsolationID
      profile: ResolvedExecutionProfile
      result: Extract<ExecutionResult, { state: "succeeded" }>
    }>,
  ): Promise<IntegratedExecutionResult>

  cleanup(
    context: WorkGraphContext,
    input: Readonly<{
      streamId: StreamID
      envelopeId: StreamEnvelopeID
      childIsolationIds?: readonly ChildIsolationID[]
      reason: "delete" | "close" | "reconcile"
      cleanupPolicy?: ResolvedExecutionProfile["cleanup"]
    }>,
  ): Promise<void>
}>
