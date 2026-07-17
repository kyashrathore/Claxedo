import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { NonNegativeInt } from "@opencode-ai/schema/schema"

const Text = Schema.String
const Timestamp = NonNegativeInt

const WorkGraphActor = Schema.Struct({
  type: Schema.Union([Schema.Literal("user"), Schema.Literal("agent"), Schema.Literal("system")]),
  id: Text,
}).annotate({ identifier: "WorkGraphActor" })

const ExecutionCapabilities = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  organizationId: Text,
  ownerUserId: Text,
  catalogRevision: Text,
  observedAt: Timestamp,
  expiresAt: Timestamp,
  environments: Schema.Array(Schema.Struct({
    kind: Schema.Union([Schema.Literal("local_worktree"), Schema.Literal("hosted_workspace")]),
    repositoryRequired: Schema.Boolean,
    remoteUrlInput: Schema.Boolean,
    baseRevisionInput: Schema.Boolean,
  })),
  harnesses: Schema.Array(Schema.Struct({ id: Text })),
  agents: Schema.Array(Schema.Struct({
    harnessId: Text,
    id: Text,
    label: Text,
    description: Schema.optional(Text),
    mode: Schema.optional(Schema.Union([Schema.Literal("primary"), Schema.Literal("subagent"), Schema.Literal("all")])),
  })),
  models: Schema.Array(Schema.Struct({
    harnessId: Text,
    providerId: Text,
    modelId: Text,
    label: Text,
    efforts: Schema.Array(Text),
  })),
  tools: Schema.Array(Schema.Struct({
    harnessId: Text,
    id: Text,
    description: Schema.optional(Text),
    requiresConnectionCapability: Schema.optional(Text),
  })),
  repository: Schema.Struct({
    remoteUrl: Schema.optional(Text),
    baseRevisions: Schema.Array(Text),
  }),
  connections: Schema.Array(Schema.Struct({
    id: Text,
    integrationId: Text,
    scope: Schema.Union([Schema.Literal("personal"), Schema.Literal("team")]),
    accountLabel: Schema.optional(Text),
    grantedCapabilities: Schema.Array(Text),
  })),
}).annotate({ identifier: "WorkGraphExecutionCapabilities" })

const WorkGraphCommandRequest = Schema.Struct({
  operationId: Text,
  command: Schema.Record(Text, Schema.Unknown),
}).annotate({ identifier: "WorkGraphCommandRequest" })

const WorkGraphCommandResult = Schema.Struct({
  ok: Schema.Literal(true),
  operationId: Text,
  cursor: Text,
  value: Schema.Unknown,
  idempotentReplay: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "WorkGraphCommandResult" })

const commandFailure = {
  ok: Schema.Literal(false),
  operationId: Text,
  error: Schema.Struct({
    code: Text,
    message: Text,
    retryable: Schema.Boolean,
    details: Schema.optional(Schema.Record(Text, Schema.Unknown)),
  }),
}

class WorkGraphCommandBadRequest extends Schema.ErrorClass<WorkGraphCommandBadRequest>("WorkGraphCommandBadRequest")(
  commandFailure,
  { httpApiStatus: 400 },
) {}
class WorkGraphCommandForbidden extends Schema.ErrorClass<WorkGraphCommandForbidden>("WorkGraphCommandForbidden")(
  commandFailure,
  { httpApiStatus: 403 },
) {}
class WorkGraphCommandNotFound extends Schema.ErrorClass<WorkGraphCommandNotFound>("WorkGraphCommandNotFound")(
  commandFailure,
  { httpApiStatus: 404 },
) {}
class WorkGraphCommandConflict extends Schema.ErrorClass<WorkGraphCommandConflict>("WorkGraphCommandConflict")(
  commandFailure,
  { httpApiStatus: 409 },
) {}
class WorkGraphCommandRejected extends Schema.ErrorClass<WorkGraphCommandRejected>("WorkGraphCommandRejected")(
  commandFailure,
  { httpApiStatus: 422 },
) {}
class WorkGraphCommandFailure extends Schema.ErrorClass<WorkGraphCommandFailure>("WorkGraphCommandFailure")(
  commandFailure,
  { httpApiStatus: 500 },
) {}
class WorkGraphCommandUnavailable extends Schema.ErrorClass<WorkGraphCommandUnavailable>("WorkGraphCommandUnavailable")(
  commandFailure,
  { httpApiStatus: 503 },
) {}

const httpFailure = {
  error: Schema.Struct({ code: Text, message: Text, retryable: Schema.Boolean }),
}
class WorkGraphBadRequest extends Schema.ErrorClass<WorkGraphBadRequest>("WorkGraphBadRequest")(
  httpFailure,
  { httpApiStatus: 400 },
) {}
class WorkGraphForbidden extends Schema.ErrorClass<WorkGraphForbidden>("WorkGraphForbidden")(
  httpFailure,
  { httpApiStatus: 403 },
) {}
class WorkGraphConflict extends Schema.ErrorClass<WorkGraphConflict>("WorkGraphConflict")(
  httpFailure,
  { httpApiStatus: 409 },
) {}

class WorkGraphExecutionCapabilitiesUnavailable extends Schema.ErrorClass<WorkGraphExecutionCapabilitiesUnavailable>(
  "WorkGraphExecutionCapabilitiesUnavailable",
)(
  {
    error: Schema.Struct({
      code: Schema.Literal("execution_capabilities_unavailable"),
      capability: Schema.Union([
        Schema.Literal("catalog_workspace"),
        Schema.Literal("runtime"),
        Schema.Literal("harnesses"),
        Schema.Literal("agents"),
        Schema.Literal("models"),
        Schema.Literal("tools"),
        Schema.Literal("repository"),
        Schema.Literal("connections"),
      ]),
      reason: Schema.Union([
        Schema.Literal("catalog_workspace_unavailable"),
        Schema.Literal("runtime_unavailable"),
        Schema.Literal("catalog_invalid"),
        Schema.Literal("repository_unavailable"),
        Schema.Literal("connections_unavailable"),
      ]),
      message: Text,
      retryable: Schema.Boolean,
    }),
  },
  { httpApiStatus: 503 },
) {}

const WorkGraphActivityQuery = Schema.Struct({
  granularity: Schema.optional(Schema.Union([
    Schema.Literal("milestones"),
    Schema.Literal("progress"),
    Schema.Literal("detailed"),
  ])),
  after: Schema.optional(Text),
  limit: Schema.optional(Schema.Number),
}).annotate({ identifier: "WorkGraphActivityQuery" })

const WorkGraphActivityEntry = Schema.Struct({
  id: Text,
  streamId: Text,
  workItemId: Text,
  category: Schema.Union([
    Schema.Literal("lifecycle"),
    Schema.Literal("attempt"),
    Schema.Literal("checkpoint"),
    Schema.Literal("decision"),
    Schema.Literal("evidence"),
    Schema.Literal("external_effect"),
  ]),
  importance: Schema.Union([
    Schema.Literal("milestones"),
    Schema.Literal("progress"),
    Schema.Literal("detailed"),
  ]),
  summary: Text,
  occurredAt: Timestamp,
  actor: WorkGraphActor,
  source: Schema.Struct({ type: Text, id: Text }),
}).annotate({ identifier: "WorkGraphActivityEntry" })

const WorkGraphActivityPage = Schema.Struct({
  entries: Schema.Array(WorkGraphActivityEntry),
  hasMore: Schema.Boolean,
  nextCursor: Schema.optional(Text),
}).annotate({ identifier: "WorkGraphActivityPage" })

export const WorkGraphGroup = HttpApiGroup.make("workgraph")
  .add(
    HttpApiEndpoint.post("workgraph.command", "/api/workgraph/commands", {
      payload: WorkGraphCommandRequest,
      success: WorkGraphCommandResult,
      error: [
        WorkGraphCommandBadRequest,
        WorkGraphCommandForbidden,
        WorkGraphCommandNotFound,
        WorkGraphCommandConflict,
        WorkGraphCommandRejected,
        WorkGraphCommandFailure,
        WorkGraphCommandUnavailable,
      ],
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.workgraph.command",
      summary: "Execute WorkGraph command",
      description: "Execute one idempotent, versioned WorkGraph command for the authenticated owner.",
    })),
  )
  .add(
    HttpApiEndpoint.get("workgraph.executionCapabilities", "/api/workgraph/execution-capabilities", {
      // Optional project selector: scopes repository (base-revision) enumeration to
      // a known local project directory. Absent → the boot repository.
      query: Schema.Struct({ directory: Schema.optional(Text) }),
      success: ExecutionCapabilities,
      error: [WorkGraphBadRequest, WorkGraphForbidden, WorkGraphExecutionCapabilitiesUnavailable],
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.workgraph.executionCapabilities",
      summary: "Get WorkGraph execution capabilities",
      description: "Read the current owner-bound, side-effect-free execution capability catalog.",
    })),
  )
  .add(
    HttpApiEndpoint.post("workgraph.refreshExecutionCapabilities", "/api/workgraph/execution-capabilities/refresh", {
      payload: Schema.Struct({}),
      success: ExecutionCapabilities,
      error: [WorkGraphBadRequest, WorkGraphForbidden, WorkGraphExecutionCapabilitiesUnavailable],
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.workgraph.refreshExecutionCapabilities",
      summary: "Refresh WorkGraph execution capabilities",
      description: "Explicitly refresh the authenticated owner's execution capability catalog.",
    })),
  )
  .add(
    HttpApiEndpoint.get("workgraph.activity", "/api/workgraph/work-items/:workItemId/activity", {
      params: { workItemId: Text },
      query: WorkGraphActivityQuery,
      success: WorkGraphActivityPage,
      error: [WorkGraphBadRequest, WorkGraphConflict],
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.workgraph.activity",
      summary: "List WorkGraph Task activity",
      description: "Read a bounded Task activity page at milestones, progress, or detailed granularity.",
    })),
  )
  .annotateMerge(OpenApi.annotations({
    title: "workgraph",
    description: "WorkGraph execution, capability, and activity routes exposed by the Claxedo composite server.",
  }))
