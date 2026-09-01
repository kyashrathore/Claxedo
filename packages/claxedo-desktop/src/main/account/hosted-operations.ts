/**
 * The closed set of authenticated calls Electron main will make.
 *
 * This is the table `docs/tech-docs/desktop-hosted-operation-matrix.md`
 * describes, expressed as code. Every entry fixes a METHOD and a PATH in main.
 * The renderer supplies an operation NAME and parameters; it never supplies a
 * url, a method, or a header, because if it could, a renderer compromise would
 * be able to spend main's credential on any route the server exposes rather
 * than the sixteen the product actually uses.
 *
 * Parameters are substituted into the path by name and encoded. They cannot
 * introduce a new segment: `:id` is replaced by one `encodeURIComponent`d
 * value, so `../../admin` becomes a literal path component rather than a
 * traversal.
 *
 * A path may carry a QUERY, and where it does the query is written out here in
 * full — `?access=cloud`, never `?access=:access`. The substitution above would
 * happily fill a `:name` inside a query string, which is exactly why the table
 * must not contain one: a caller-selected query is a caller-selected request,
 * and then the set of calls main can make is no longer the set written down
 * here. `hosted-operations.test.ts` holds that property.
 *
 * Adding an operation means adding a matrix row AND an entry here.
 * `hosted-operations.test.ts` holds the two equal.
 */

export type HostedOperation = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** Path template; `:name` segments are filled from the caller's parameters. */
  path: string
  /** Parameter names that go in the body rather than the path. */
  body?: string[]
  /**
   * Declared query keys filled from the caller's parameters.
   *
   * Distinct from putting `:name` in the path's query string: those keys are
   * fixed here, so the set of requests stays enumerable. A free-form
   * `?access=:access` is still forbidden.
   *
   * Keys in `query` are required. Keys in `optionalQuery` are omitted when
   * absent (e.g. resolve-by-id OR resolve-by-directory).
   */
  query?: string[]
  optionalQuery?: string[]
  /**
   * Declared request headers filled from caller parameters.
   * Map of parameter name → HTTP header name (e.g. `{ ifMatch: "If-Match" }`).
   */
  headers?: Record<string, string>
  /** Preserve status plus the canonical JSON body for callers with expected non-2xx outcomes. */
  response?: "http"
}

export const HOSTED_OPERATIONS = {
  "account.mode": { method: "GET", path: "/api/claxedo/mode" },
  "account.compatibility": { method: "GET", path: "/api/claxedo/compatibility" },
  // No idempotency key. The app registry says "the idempotency key for that
  // lives in main"; it does not — nothing in this process, for any operation,
  // has ever had one, and this table has no way to express one. The route
  // dedupes nothing either: `POST /api/auth/cli/exchange`
  // (`routes/hosted/device-auth.ts`) mints from the BEARER and never reads the
  // body at all, so `code` is declared here and ignored there, and every call
  // is a fresh, separately-revocable session pair. Harmless only because the
  // renderer cannot reach it — see `RENDERER_WITHHELD_OPERATIONS` — and no
  // main-side caller exists.
  "account.cliExchange": { method: "POST", path: "/api/auth/cli/exchange", body: ["code"] },
  "agentPlugins.catalog": { method: "GET", path: "/api/claxedo/plugins", response: "http" },
  "agentPlugins.catalog.refresh": { method: "GET", path: "/api/claxedo/plugins/refresh", response: "http" },
  "agentPlugins.catalog.project": { method: "GET", path: "/api/claxedo/plugins/projects/:projectId", response: "http" },
  "agentPlugins.catalog.project.refresh": { method: "GET", path: "/api/claxedo/plugins/projects/:projectId/refresh", response: "http" },
  "agentPlugins.activation": {
    method: "POST",
    path: "/api/claxedo/plugins/activation",
    body: ["pluginInstanceId", "harnessIds", "choice", "expectedRevision", "target"],
    response: "http",
  },
  "agentPlugins.organizationDefault": {
    method: "POST",
    path: "/api/claxedo/plugins/organization-default",
    body: ["pluginInstanceId", "harnessIds", "choice", "expectedRevision"],
    response: "http",
  },
  "agentPlugins.update": {
    method: "POST",
    path: "/api/claxedo/plugins/update",
    body: ["pluginInstanceId", "expectedRevision", "authority"],
    response: "http",
  },
  // TWO operations, one per access kind, each with the access FIXED in the path.
  //
  // `GET /api/workspace` with no `?access=` is not a broader list — it is
  // `{ workspaces: [] }`, always. The hosted handler (`routes/hosted/workspace.ts`)
  // only requires a signed caller, only asks the authority, and only answers
  // rows when `access` is `cloud` or `user-hosted`; every other value falls
  // through to the empty envelope. The single access-less row this replaces
  // could therefore never return a workspace, and never did.
  //
  // Not one row with an `access` PARAMETER, which this table could express
  // today — `?access=:access` would substitute like any other `:name`. Two
  // reasons it must not:
  //   - Nothing chooses a kind at runtime. The caller wants BOTH and merges
  //     them (`claxedo-app/.../features/session/data/sync/inventory-source.ts`,
  //     `fetchSignedWorkspaceSnapshotUncached`), so the kind is a constant at
  //     each call site. A parameter would buy no caller flexibility and would
  //     cost the closed set its enumerability: what main can request would stop
  //     being readable here and start depending on what the renderer passes.
  //   - Withholding is per NAME (`RENDERER_WITHHELD_OPERATIONS`). One
  //     parameterized row cannot be withheld for one access kind and allowed
  //     for the other; two rows can.
  "workspace.list.cloud": { method: "GET", path: "/api/workspace?access=cloud" },
  "workspace.list.userHosted": { method: "GET", path: "/api/workspace?access=user-hosted" },
  // Optional query: callers pass workspaceId and/or directory and/or create.
  "workspace.resolve": {
    method: "GET",
    path: "/api/workspace/resolve",
    optionalQuery: ["workspaceId", "directory", "create"],
  },
  // `projectName`/`workspaceName`, not `displayName`. The create body is a
  // strict schema, so an undeclared field is a 400 for the whole request rather
  // than a field the server ignores — `displayName` made this operation
  // unusable from the day it was written.
  //
  // Connected-repository create needs `connectionId` + `repo: { fullName }`.
  // Parameters here stay scalars (`repoFullName`); `resolveHostedOperation`
  // nests that into the `repo` object the hosted schema requires.
  //
  // NO IDEMPOTENCY KEY, and one cannot be added from this side. The matrix once
  // classified this row `idempotency-key`; there is no key anywhere. This table
  // expresses a request as method + path + declared body — there is no header
  // seam — and the route's body schema is `.strict()` with no idempotency field
  // (`createCloudBody`, `routes/hosted/workspace.ts`), so a key declared here
  // would 400 every create rather than dedupe a retry. That is the same failure
  // `displayName` caused above. Until the route accepts one, this operation is
  // genuinely `unsafe`: an uncertain response must be surfaced, never retried,
  // because a retry provisions a second billable sandbox. Nothing retries it
  // today — `account-service.run` performs exactly one fetch, and the composer
  // surfaces an uncertain response rather than provisioning again.
  // `isSafeOperation` in the app registry already answers false for it, and
  // that is the property a retry loop must consult.
  "workspace.create": {
    method: "POST",
    path: "/api/workspace/create",
    body: ["projectId", "projectName", "workspaceName", "repoUrl", "gitBranch", "driver", "connectionId", "repoFullName"],
  },
  // `approved` is not decoration. Every lifecycle operation except `stop`
  // refuses with 409 unless the caller states the approval explicitly, and an
  // operation that declares no body can never state it.
  "workspace.lifecycle": {
    method: "POST",
    path: "/api/workspace/:id/lifecycle/:operation",
    body: ["approved", "checkpointId"],
  },
  "workspace.checkpoints.list": { method: "GET", path: "/api/workspace/:id/checkpoints" },
  "workspace.checkpoints.create": {
    method: "POST",
    path: "/api/workspace/:id/checkpoints",
    body: ["policy"],
  },
  "workspace.checkpoints.restore": {
    method: "POST",
    path: "/api/workspace/:id/checkpoints/:checkpointId/restore",
    body: ["approved"],
  },
  "workspace.connection.mint": { method: "GET", path: "/api/workspace/:id/connection" },
  "workspace.connection.refresh": {
    method: "POST",
    path: "/api/workspace/:id/connection/refresh",
    body: ["previousJti"],
  },
  // Control-plane session inventory for a workspace (signed rail).
  "session.list": {
    method: "GET",
    path: "/api/control/sessions",
    query: ["workspaceId"],
  },
  // Paginated rail rows (`session-list`), distinct from flat `session.list`.
  "session.navigationList": {
    method: "GET",
    path: "/api/control/session-list",
    query: ["scope", "limit"],
    optionalQuery: [
      "projectId",
      "workspaceId",
      "directory",
      "groupBy",
      "archived",
      "status",
      "environment",
      "git",
      "search",
      "sort",
      "cursor",
    ],
  },
  "session.projection.register": {
    method: "POST",
    path: "/api/control/workspaces/:workspaceId/sessions/:sessionId/register",
    body: ["idempotencyKey", "reason", "expectedEventOrdinal"],
  },
  "session.projection.checkpoint": {
    method: "POST",
    path: "/api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint",
    body: ["idempotencyKey", "reason", "expectedEventOrdinal"],
  },
  "session.projection.repair": {
    method: "POST",
    path: "/api/control/workspaces/:workspaceId/sessions/:sessionId/repair",
    body: ["idempotencyKey", "reason", "expectedEventOrdinal"],
  },
  // Central control-plane event bus. Consumed via stream IPC (`openStream`), not unary `run`.
  "session.events": {
    method: "GET",
    path: "/api/wr/events",
    headers: { lastEventId: "Last-Event-ID" },
  },
  // Per-session central runtime event bus (control plane, not post-mint RAT).
  "session.runtimeEvents": {
    method: "GET",
    path: "/api/control/session/:sessionId/runtime-events",
    query: ["parentSessionId"],
    headers: { lastEventId: "Last-Event-ID" },
  },
  // MAIN-ONLY. `publicKey` and `signature` are the machine identity, and the
  // route stores whatever public key it is handed — so a caller that supplies
  // them enrolls a machine whose private half nobody else holds. The only
  // legitimate caller is the Host Connector child. Electron brokers this
  // fixed named operation and the child fills these from the key bootstrapped
  // by `host-connector/identity-store.ts`; the renderer reaches the same
  // feature through the connector's own zero-argument IPC. That refusal is
  // enforced by `RENDERER_WITHHELD_OPERATIONS` in `account-ipc.ts`, which is
  // where the whole argument is written down.
  //
  // Retry IS idempotent, and by the machine identity rather than a key the
  // caller invents: `enrollForUser` patches the existing row for the same
  // `host_id` instead of inserting a second one.
  "host.enrollCurrentMachine": {
    method: "POST",
    path: "/api/claxedo/host/enrollments",
    body: ["hostId", "publicKey", "requestId", "signature", "displayName"],
  },
  // `enrollmentNonce`, not `enrollmentRequest`: an operation name ending in
  // "Request" trips the generic-passthrough guard, which is watching for
  // exactly the `proxyRequest`/`hostedFetch` shape this whole table exists to
  // prevent. The guard was right and "nonce" is the more accurate word.
  //
  // The nonce the machine signs, and the presence beat. Both are signed-only
  // routes, so the connector reaches them through the account rather than
  // holding a bearer of its own — the machine key proves the MACHINE, the
  // account bearer proves the owner, and enrollment needs both.
  "host.enrollmentNonce": { method: "POST", path: "/api/claxedo/host/enrollments/requests", body: ["hostId"] },
  "host.enrollmentHeartbeat": {
    method: "POST",
    path: "/api/claxedo/host/enrollments/heartbeat",
    body: ["hostId", "signature", "ttlMs", "workspaceIds", "sessionAuthority"],
  },
  // Session people (private share grants + participants). Hosted control plane
  // only — the desktop local sidecar deliberately does not mount these routes.
  "session.shares.list": {
    method: "GET",
    path: "/api/control/sessions/:sessionId/shares",
    query: ["workspaceId"],
  },
  "session.shares.grant": {
    method: "POST",
    path: "/api/control/sessions/:sessionId/shares",
    body: [
      "workspaceId",
      "grantedToTokenIdentifier",
      "grantedToTeamPublicId",
      "grantedToOrgId",
    ],
  },
  "session.shares.revoke": {
    method: "DELETE",
    path: "/api/control/sessions/:sessionId/shares",
    body: [
      "workspaceId",
      "grantId",
      "grantedToTokenIdentifier",
      "grantedToTeamPublicId",
    ],
  },
  "session.participants.add": {
    method: "POST",
    path: "/api/control/sessions/:sessionId/participants",
    body: ["workspaceId", "participantActorId"],
  },
  "org.list": { method: "GET", path: "/api/control/orgs" },
  "org.create": {
    method: "POST",
    path: "/api/control/orgs",
    body: ["name"],
  },
  "org.teams.list": {
    method: "GET",
    path: "/api/control/orgs/:orgId/teams",
  },
  "org.teams.create": {
    method: "POST",
    path: "/api/control/orgs/:orgId/teams",
    body: ["name"],
  },
  "org.ensureDefaultTeam": {
    method: "POST",
    path: "/api/control/orgs/:orgId/ensure-default-team",
  },
  "team.members.list": {
    method: "GET",
    path: "/api/control/teams/:teamId/members",
  },
  "team.members.add": {
    method: "POST",
    path: "/api/control/teams/:teamId/members",
    body: ["tokenIdentifier", "providerSubject", "userPublicId", "role"],
  },
  "team.members.remove": {
    method: "DELETE",
    path: "/api/control/teams/:teamId/members",
    body: ["tokenIdentifier", "userPublicId"],
  },
  "team.projects.grant": {
    method: "POST",
    path: "/api/control/teams/:teamId/projects",
    body: ["projectId", "role"],
  },
  "connections.list": { method: "GET", path: "/api/claxedo/integrations" },
  "connections.connect": {
    method: "POST",
    path: "/api/claxedo/integrations/:id/connect",
    // `issuer` carries a tenant-specific OAuth authority for integrations that
    // have one; declared here so the signed desktop path does not silently drop
    // it the way an undeclared field would.
    body: ["method", "fields", "secret", "confirmReplace", "scope", "issuer"],
  },
  "connections.attempt": {
    method: "GET",
    path: "/api/claxedo/integrations/attempts/:state",
  },
  "connections.repositories": {
    method: "GET",
    path: "/api/claxedo/integrations/connections/:id/repositories",
  },
  "connections.disconnect": {
    method: "DELETE",
    path: "/api/claxedo/integrations/connections/:id",
  },
  "connections.reverify": {
    method: "POST",
    path: "/api/claxedo/integrations/connections/:id/reverify",
  },
  "documents.list": {
    method: "GET",
    path: "/documents",
    optionalQuery: ["project_id", "document_id", "directory", "archived"],
  },
  "documents.get": { method: "GET", path: "/documents/:id" },
  "documents.create": {
    method: "POST",
    path: "/documents",
    body: ["project_id", "directory", "display_name", "markdown"],
  },
  "documents.update": {
    method: "PATCH",
    path: "/documents/:id",
    body: ["display_name", "session_id"],
    headers: { ifMatch: "If-Match" },
  },
  "documents.content.get": { method: "GET", path: "/documents/:id/content" },
  "documents.content.put": {
    method: "PUT",
    path: "/documents/:id/content",
    body: ["display_name", "markdown"],
    headers: { ifMatch: "If-Match" },
  },
  "documents.snapshots": { method: "GET", path: "/documents/:id/snapshots" },
  "documents.snapshots.restore": {
    method: "POST",
    path: "/documents/:id/snapshots/:snapshotId/restore",
    headers: { ifMatch: "If-Match" },
  },
  "documents.workSource": {
    method: "POST",
    path: "/documents/:id/work-source",
    body: ["target_stream_id", "directory", "repository_url"],
  },
  "documents.workSourcePin": {
    method: "POST",
    path: "/documents/:id/snapshots/:snapshotId/work-source-pin",
    body: ["work_source_id", "revision_id"],
  },
  "documents.statuses": {
    method: "GET",
    path: "/documents/statuses",
    optionalQuery: ["project_id", "document_id", "directory", "archived"],
  },
  "session.create": {
    method: "POST",
    path: "/api/control/sessions",
    body: ["mode", "workspaceId", "title", "directory", "harness", "model", "toolSandbox"],
  },
  "session.messages": {
    method: "GET",
    path: "/api/control/sessions/:sessionId/messages",
    optionalQuery: ["workspaceId", "view", "limit", "before", "after"],
  },
  "session.gateway": {
    method: "GET",
    path: "/api/control/sessions/:sessionId/gateway",
    optionalQuery: ["workspaceId"],
  },
  "billing.checkout": { method: "POST", path: "/api/billing/checkout", body: ["plan"] },
  "billing.portal": { method: "POST", path: "/api/billing/portal" },
  "workspace.assignHost": {
    method: "POST",
    path: "/api/workspace/:id/host-assignment",
    body: ["hostId", "displayName", "orgId", "projectId", "repoUrl", "repoName", "gitBranch", "remoteDirectory"],
  },
  "workspace.unassignHost": {
    method: "DELETE",
    path: "/api/workspace/:id/host-assignment",
  },
  "usage.get": {
    method: "GET",
    path: "/api/claxedo/usage",
    optionalQuery: [
      "since",
      "until",
      "timezone",
      "view",
      "group",
      "after",
      "model_after",
      "limit",
      "refresh_nonce",
      "filter_provider",
      "filter_harness",
      "filter_model",
      "filter_location",
      "filter_session",
      "filter_workspace",
      "filter_app",
    ],
  },
  "usage.sync": { method: "POST", path: "/api/claxedo/usage/sync" },
  "documents.export": { method: "GET", path: "/documents/:id/export" },
  "documents.agentOpen": {
    method: "POST",
    path: "/documents/:id/agent-open",
    body: ["session_id"],
  },
  "documents.runtimeConflictResolve": {
    method: "POST",
    path: "/documents/:id/runtime-conflict/resolve",
    body: ["session_id", "choice"],
  },
  "documents.moveToRepository": {
    method: "POST",
    path: "/documents/:id/move-to-repository",
    body: ["workspace_id", "path"],
  },
  "documents.fromRepo": {
    method: "POST",
    path: "/documents/from-repo",
    body: ["project_id", "directory", "workspace_id", "path", "display_name", "status", "session_id"],
  },
} as const satisfies Record<string, HostedOperation>

export type HostedOperationName = keyof typeof HOSTED_OPERATIONS

/**
 * Operations that must not go through unary `run()` (SSE / binary stream).
 * Path resolution still uses `HOSTED_OPERATIONS`; the IPC open/close stream
 * channels own the Response lifetime.
 */
export const STREAM_HOSTED_OPERATIONS = [
  "session.events",
  "session.runtimeEvents",
] as const satisfies readonly HostedOperationName[]

export function isStreamHostedOperation(name: string): name is (typeof STREAM_HOSTED_OPERATIONS)[number] {
  return (STREAM_HOSTED_OPERATIONS as readonly string[]).includes(name)
}

export type ResolvedRequest = {
  method: string
  path: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
  /** Preserve status plus the canonical JSON body for callers with expected non-2xx outcomes. */
  response?: "http"
}

export class UnknownHostedOperation extends Error {}
export class MissingOperationParameter extends Error {}

/**
 * Turn a named operation plus parameters into the one request it stands for.
 *
 * Rejects an unknown name rather than falling through to a default. There is no
 * default — the whole design is that an operation nobody wrote down cannot be
 * performed.
 */
export function resolveHostedOperation(
  name: string,
  input: Record<string, unknown> = {},
): ResolvedRequest {
  const operation = (HOSTED_OPERATIONS as Record<string, HostedOperation | undefined>)[name]
  if (!operation) throw new UnknownHostedOperation(`no hosted operation named "${name}"`)

  let method = operation.method
  if (name === "agentConfig.extensions.write") {
    const requested = String(input.httpMethod ?? "POST").toUpperCase()
    if (requested !== "POST" && requested !== "PUT" && requested !== "DELETE") {
      throw new MissingOperationParameter(`operation "${name}" requires httpMethod POST|PUT|DELETE`)
    }
    method = requested
  }

  let path = operation.path
  if (path.endsWith("/*")) {
    const subpath = String(input.subpath ?? "")
    if (subpath.includes("..") || subpath.includes("://") || subpath.startsWith("//")) {
      throw new MissingOperationParameter(`operation "${name}" requires a safe subpath`)
    }
    const suffix = subpath.replace(/^\//, "")
    // Empty subpath means the collection root (no trailing slash), used by
    // agent-config extensions list/install. Owner-scoped callers always pass a
    // non-empty relative path.
    path = suffix ? `${path.slice(0, -1)}${suffix}` : path.slice(0, -2)
  } else {
    path = path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, key: string) => {
      const value = input[key]
      if (value === undefined || value === null || value === "") {
        throw new MissingOperationParameter(`operation "${name}" requires ${key}`)
      }
      // Encoded, so a parameter cannot add a path segment or a query string.
      return encodeURIComponent(String(value))
    })
  }

  if (operation.query?.length || operation.optionalQuery?.length) {
    const params = new URLSearchParams()
    for (const key of operation.query ?? []) {
      const value = input[key]
      if (value === undefined || value === null || value === "") {
        throw new MissingOperationParameter(`operation "${name}" requires ${key}`)
      }
      params.set(key, String(value))
    }
    for (const key of operation.optionalQuery ?? []) {
      const value = input[key]
      if (value === undefined || value === null || value === "") continue
      params.set(key, String(value))
    }
    const qs = params.toString()
    if (qs) path = `${path}?${qs}`
  }

  const headers: Record<string, string> = {}
  for (const [param, headerName] of Object.entries(operation.headers ?? {})) {
    const value = input[param]
    if (value === undefined || value === null || value === "") continue
    headers[headerName] = String(value)
  }

  // Only carried when actually present, so a resolved request keeps the exact
  // shape the operation declares — no empty `headers`, no absent `response`.
  const extra: Pick<ResolvedRequest, "headers" | "response"> = {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(operation.response ? { response: operation.response } : {}),
  }

  if (!operation.body) {
    return { method, path, ...extra }
  }

  // Only the declared fields. A caller passing extra keys is not an error worth
  // failing on, but those keys must not reach the server — an undeclared field
  // is one nobody reviewed.
  const body: Record<string, unknown> = {}
  for (const key of operation.body) {
    if (input[key] !== undefined) body[key] = input[key]
  }
  // Hosted createCloudBody wants `repo: { fullName }`. Keep the IPC parameter
  // a scalar (`repoFullName`) and nest only here so the closed set stays flat.
  if (name === "workspace.create" && typeof body.repoFullName === "string" && body.repoFullName) {
    body.repo = { fullName: body.repoFullName }
    delete body.repoFullName
  }
  // agent-config writes pass an opaque JSON object as `payload`.
  if (name === "agentConfig.extensions.write") {
    const payload = body.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { method, path, body: {}, ...extra }
    }
    return { method, path, body: payload as Record<string, unknown>, ...extra }
  }
  return { method, path, body, ...extra }
}

/** The IPC channel a named operation travels on. One per operation, by name. */
export function hostedOperationChannel(name: HostedOperationName) {
  return `claxedo.account.operation:${name}`
}
