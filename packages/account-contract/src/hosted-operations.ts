import { isPluginId } from "@claxedo/plugin-api/id"
import { CREDENTIAL_OPERATIONS } from "./credential-operations"
import { sharedSessions } from "./shared-sessions"
import { USAGE_OPERATIONS } from "./usage-operations"
import {
  defineOperation, operationPath, requiredParameter, optionalParameter, bodyField,
  selectBody, operationHeaders, pluginMethod, pluginBody, connectedRepositoryBody,
  type Decoder, type ResolvedRequest,
  MissingOperationParameter, UnknownHostedOperation,
} from "./operation-definition"
import { operationInput } from "./operation-input"
import { object, withStrings, array, withArrays, sessionPeople, withRecord, nullable, optional, connection, statusResult } from "./hosted-output"

export const CORE_HOSTED_OPERATIONS = {
  ...CREDENTIAL_OPERATIONS,
  ...USAGE_OPERATIONS,
  "session.shared.list": defineOperation({
    method: "GET", path: operationPath("/api/workspace/shared-sessions"),
    input: operationInput({}), output: sharedSessions, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.connection.read": defineOperation({
    method: "GET", path: operationPath("/api/workspace/:id/connection", { query: ["sessionId"] }),
    input: operationInput({ id: requiredParameter, sessionId: requiredParameter }),
    output: connection, retry: "safe", exposure: { renderer: true, app: false },
  }),
  "account.mode": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/mode"),
    input: operationInput({}),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "account.compatibility": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/compatibility"),
    input: operationInput({}),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  // Withheld from the renderer: the answer is a long-lived CLI access and
  // refresh pair, and every exchange is a real mint in the revocation registry.
  // The web CLI login fetches the exchange with the page's own session.
  "account.cliExchange": defineOperation({
    method: "POST", path: operationPath("/api/auth/cli/exchange"),
    input: operationInput({ code: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: false, app: false },
    body: selectBody("code"),
  }),
  "agentPlugins.catalog": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins"),
    input: operationInput({}),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  "agentPlugins.catalog.refresh": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins/refresh"),
    input: operationInput({}),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  "agentPlugins.catalog.project": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins/projects/:projectId"),
    input: operationInput({ projectId: requiredParameter }),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  "agentPlugins.catalog.project.refresh": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins/projects/:projectId/refresh"),
    input: operationInput({ projectId: requiredParameter }),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  "agentPlugins.activation": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/plugins/activation"),
    input: operationInput({ pluginInstanceId: bodyField, harnessIds: bodyField, choice: bodyField, expectedRevision: bodyField, target: bodyField }),
    output: statusResult, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("pluginInstanceId", "harnessIds", "choice", "expectedRevision", "target"),
    response: "http",
  }),
  "agentPlugins.organizationDefault": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/plugins/organization-default"),
    input: operationInput({ pluginInstanceId: bodyField, harnessIds: bodyField, choice: bodyField, expectedRevision: bodyField }),
    output: statusResult, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("pluginInstanceId", "harnessIds", "choice", "expectedRevision"),
    response: "http",
  }),
  "agentPlugins.update": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/plugins/update"),
    input: operationInput({ pluginInstanceId: bodyField, expectedRevision: bodyField, authority: bodyField }),
    output: statusResult, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("pluginInstanceId", "expectedRevision", "authority"),
    response: "http",
  }),
  "agentPlugins.skill": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins/:pluginInstanceId/skills/:skill"),
    input: operationInput({ pluginInstanceId: requiredParameter, skill: requiredParameter }),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  "agentPlugins.skill.project": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins/projects/:projectId/:pluginInstanceId/skills/:skill"),
    input: operationInput({ projectId: requiredParameter, pluginInstanceId: requiredParameter, skill: requiredParameter }),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  "agentPlugins.sources.list": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins/sources"),
    input: operationInput({}),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  "agentPlugins.sources.add": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/plugins/sources"),
    input: operationInput({ owner: bodyField, repository: bodyField, ref: bodyField, authority: bodyField }),
    output: statusResult, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("owner", "repository", "ref", "authority"),
    response: "http",
  }),
  "agentPlugins.sources.remove": defineOperation({
    method: "DELETE", path: operationPath("/api/claxedo/plugins/sources/:id"),
    input: operationInput({ id: requiredParameter }),
    output: statusResult, retry: "safe",
    exposure: { renderer: true, app: false },
    response: "http",
  }),
  // Withheld from the renderer: the answer carries MCP gateway bearer
  // credentials, which main hands to the daemon and never to a page.
  "agentPlugins.runtimeSelf": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/plugins/runtime/self"),
    input: operationInput({}),
    output: statusResult, retry: "safe",
    exposure: { renderer: false, app: false },
    response: "http",
  }),
  "machines.list": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/remote-access/devices"),
    input: operationInput({}),
    output: withArrays("devices"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  // The route pauses every machine of the owner's when it is handed no
  // `hostId`, so these two require one and fix `paused` in the body.
  "machines.pause": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/enrollments/pause"),
    input: operationInput({ hostId: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
    body: (input) => ({ hostId: input.hostId, paused: true }),
  }),
  "machines.resume": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/enrollments/pause"),
    input: operationInput({ hostId: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
    body: (input) => ({ hostId: input.hostId, paused: false }),
  }),
  "machines.remove": defineOperation({
    method: "DELETE", path: operationPath("/api/claxedo/remote-access/devices/:hostId"),
    input: operationInput({ hostId: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
  "machines.pair": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/pairings"),
    input: operationInput({}),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: () => ({}),
  }),
  "machines.pairing": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/host/pairings/:pairingId"),
    input: operationInput({ pairingId: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "machines.requests": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/host/pairings"),
    input: operationInput({}),
    output: withArrays("requests"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "machines.approve": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/pairings/:pairingId/approve"),
    input: operationInput({ pairingId: requiredParameter, displayName: optionalParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("displayName"),
  }),
  "machines.deny": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/pairings/:pairingId/deny"),
    input: operationInput({ pairingId: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: () => ({}),
  }),
  // Run before a sign-out ends the session, so a pasted command whose code
  // no machine redeemed yet answers that its person signed out.
  "machines.cancelPairings": defineOperation({
    method: "DELETE", path: operationPath("/api/claxedo/host/pairings"),
    input: operationInput({}),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "machines.folders": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/machines/:enrollmentId/folders"),
    input: operationInput({ enrollmentId: requiredParameter, read: bodyField, directory: bodyField, query: bodyField, limit: bodyField }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
    body: selectBody("read", "directory", "query", "limit"),
  }),
  // The route `claxedo host assign` uses, for a folder the person picked in
  // the app on one of their own machines: the plane refuses any other host,
  // and the folder joins that machine's roots. The app names a new workspace
  // id for each pick, so no existing workspace is re-pointed.
  "machines.assign": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:workspaceId/host-assignment"),
    input: operationInput({ workspaceId: requiredParameter, hostId: bodyField, displayName: bodyField, repoName: bodyField, remoteDirectory: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => ({ ...selectBody("hostId", "displayName", "repoName", "remoteDirectory")(input), addRoot: true }),
  }),
  "workspace.list.provisioner": defineOperation({
    method: "GET", path: operationPath("/api/workspace?host=provisioner"),
    input: operationInput({}),
    output: withArrays("workspaces"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "workspace.resolve": defineOperation({
    method: "GET", path: operationPath("/api/workspace/resolve", { optionalQuery: ["workspaceId", "directory"] }),
    input: operationInput({ workspaceId: optionalParameter, directory: optionalParameter }),
    output: nullable(object), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "workspace.create": defineOperation({
    method: "POST", path: operationPath("/api/workspace/create"),
    input: operationInput({ projectId: bodyField, workspaceName: bodyField, repoUrl: bodyField, gitBranch: bodyField, driver: bodyField, machineClass: bodyField, connectionId: bodyField, repoFullName: bodyField }),
    output: withStrings("workspaceId", "directory"), retry: "never",
    exposure: { renderer: true, app: false },
    body: connectedRepositoryBody,
  }),
  "workspace.lifecycle": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:id/lifecycle/:operation"),
    input: operationInput({ id: requiredParameter, operation: requiredParameter, approved: bodyField, checkpointId: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("approved", "checkpointId"),
  }),
  "workspace.checkpoints.list": defineOperation({
    method: "GET", path: operationPath("/api/workspace/:id/checkpoints"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "workspace.checkpoints.create": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:id/checkpoints"),
    input: operationInput({ id: requiredParameter, policy: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("policy"),
  }),
  "workspace.checkpoints.restore": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:id/checkpoints/:checkpointId/restore"),
    input: operationInput({ id: requiredParameter, checkpointId: requiredParameter, approved: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("approved"),
  }),
  // The renderer's runtime reads need the workspace's relay token without waking it; main keeps the account bearer.
  "workspace.connection.read": defineOperation({
    method: "GET", path: operationPath("/api/workspace/:id/connection"),
    input: operationInput({ id: requiredParameter }),
    output: connection, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "workspace.connection.mint": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:id/connection"),
    input: operationInput({ id: requiredParameter, retry: bodyField, updateImage: bodyField }),
    output: connection, retry: "safe",
    exposure: { renderer: true, app: false },
    body: selectBody("retry", "updateImage"),
  }),
  // A session the plane reserved in its own host, connected to before it is created there.
  "session.connection.mint": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:id/connection"),
    input: operationInput({ id: requiredParameter, sessionId: requiredParameter }),
    output: connection, retry: "safe",
    exposure: { renderer: true, app: false },
    body: (input) => ({ session: { sessionId: input.sessionId } }),
  }),
  "workspace.connection.refresh": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:id/connection/refresh"),
    input: operationInput({ id: requiredParameter, previousJti: bodyField }),
    output: connection, retry: "safe",
    exposure: { renderer: true, app: false },
    body: selectBody("previousJti"),
  }),
  // Cloud create needs authority admission; main spends the account bearer on this fixed route.
  "session.reserve": defineOperation({
    method: "POST", path: operationPath("/api/control/session-registrations/reserve"),
    input: operationInput({ workspaceId: requiredParameter, sessionId: requiredParameter, operationId: requiredParameter, title: bodyField, harness: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => ({ ...selectBody("workspaceId", "sessionId", "operationId", "title", "harness")(input), kind: "create" }),
  }),
  "session.list": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions", { query: ["workspaceId"] }),
    input: operationInput({ workspaceId: requiredParameter }),
    output: withArrays("sessions"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.page": defineOperation({
    method: "GET", path: operationPath("/api/control/session-list?scope=project", { query: ["projectId", "limit"], optionalQuery: ["sort", "after", "settled"] }),
    input: operationInput({ projectId: requiredParameter, limit: requiredParameter, sort: optionalParameter, after: optionalParameter, settled: optionalParameter }),
    output: withArrays("items"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.pages": defineOperation({
    method: "GET", path: operationPath("/api/control/session-list?scope=projects", { query: ["limit"], optionalQuery: ["sort", "settled"] }),
    input: operationInput({ limit: requiredParameter, sort: optionalParameter, settled: optionalParameter }),
    output: withArrays("pages"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.activity.page": defineOperation({
    method: "GET", path: operationPath("/api/control/session-list?scope=all", { query: ["limit"], optionalQuery: ["sort", "after", "settled", "sessionId"] }),
    input: operationInput({ limit: requiredParameter, sort: optionalParameter, after: optionalParameter, settled: optionalParameter, sessionId: optionalParameter }),
    output: withArrays("items"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.projection.register": defineOperation({
    method: "POST", path: operationPath("/api/control/workspaces/:workspaceId/sessions/:sessionId/register"),
    input: operationInput({ workspaceId: requiredParameter, sessionId: requiredParameter, idempotencyKey: bodyField, reason: bodyField, expectedEventOrdinal: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("idempotencyKey", "reason", "expectedEventOrdinal"),
  }),
  "session.projection.checkpoint": defineOperation({
    method: "POST", path: operationPath("/api/control/workspaces/:workspaceId/sessions/:sessionId/checkpoint"),
    input: operationInput({ workspaceId: requiredParameter, sessionId: requiredParameter, idempotencyKey: bodyField, reason: bodyField, expectedEventOrdinal: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("idempotencyKey", "reason", "expectedEventOrdinal"),
  }),
  "session.projection.repair": defineOperation({
    method: "POST", path: operationPath("/api/control/workspaces/:workspaceId/sessions/:sessionId/repair"),
    input: operationInput({ workspaceId: requiredParameter, sessionId: requiredParameter, idempotencyKey: bodyField, reason: bodyField, expectedEventOrdinal: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("idempotencyKey", "reason", "expectedEventOrdinal"),
  }),
  "controlPlane.events": defineOperation({
    method: "GET", path: operationPath("/api/cp/events"),
    input: operationInput({ lastEventId: optionalParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false, stream: true },
    headers: operationHeaders({ lastEventId: "Last-Event-ID" }),
  }),
  // Withheld from the renderer: the route stores whatever public key and
  // signature it is handed and upserts on (owner, host_id), so a renderer could
  // enroll its own keypair under the owner, or take over or un-revoke a
  // machine. Main brokers it for the Host Connector child, which supplies the
  // key from the machine identity store; the renderer's route is the
  // connector's own `start`.
  "host.enrollCurrentMachine": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/enrollments"),
    input: operationInput({ hostId: bodyField, publicKey: bodyField, requestId: bodyField, signature: bodyField, displayName: bodyField }),
    output: withRecord("enrollment", withStrings("enrollment_id", "host_id")), retry: "never",
    exposure: { renderer: false, app: false },
    body: selectBody("hostId", "publicKey", "requestId", "signature", "displayName"),
  }),
  // Withheld from the renderer: step one of the enrollment handshake above.
  "host.enrollmentNonce": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/enrollments/requests"),
    input: operationInput({ hostId: bodyField }),
    output: withStrings("request_id", "nonce"), retry: "never",
    exposure: { renderer: false, app: false },
    body: selectBody("hostId"),
  }),
  // Withheld from the renderer: it names an enrollment id, and every
  // enrollment the owner holds answers to it; the renderer's route is the
  // connector's own `rename`, which carries a name only.
  "host.renameCurrentMachine": defineOperation({
    method: "PATCH", path: operationPath("/api/claxedo/host/enrollments/:enrollmentId/display-name"),
    input: operationInput({ enrollmentId: requiredParameter, displayName: bodyField }),
    output: withStrings("enrollment_id", "display_name"), retry: "never",
    exposure: { renderer: false, app: false },
    body: selectBody("displayName"),
  }),
  "session.seen": defineOperation({
    method: "POST", path: operationPath("/api/control/sessions/:sessionId/seen"),
    input: operationInput({ sessionId: requiredParameter, completedAt: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("completedAt"),
  }),
  "session.settle": defineOperation({
    method: "POST", path: operationPath("/api/control/sessions/:sessionId/settle"),
    input: operationInput({ sessionId: requiredParameter, settled: bodyField, through: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("settled", "through"),
  }),
  "session.shares.list": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions/:sessionId/shares", { query: ["workspaceId"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: requiredParameter }),
    output: sessionPeople, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.shares.grant": defineOperation({
    method: "POST", path: operationPath("/api/control/sessions/:sessionId/shares"),
    input: operationInput({ sessionId: requiredParameter, workspaceId: bodyField, level: bodyField, grantedToTokenIdentifier: bodyField, grantedToUserId: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("workspaceId", "level", "grantedToTokenIdentifier", "grantedToUserId"),
  }),
  "session.shares.revoke": defineOperation({
    method: "DELETE", path: operationPath("/api/control/sessions/:sessionId/shares"),
    input: operationInput({ sessionId: requiredParameter, workspaceId: bodyField, grantId: bodyField, grantedToTokenIdentifier: bodyField, grantedToUserId: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("workspaceId", "grantId", "grantedToTokenIdentifier", "grantedToUserId"),
  }),
  "org.list": defineOperation({
    method: "GET", path: operationPath("/api/control/orgs"),
    input: operationInput({}),
    output: array, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "org.create": defineOperation({
    method: "POST", path: operationPath("/api/control/orgs"),
    input: operationInput({ name: bodyField }),
    output: withStrings("org_id", "name"), retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("name"),
  }),
  "org.teams.list": defineOperation({
    method: "GET", path: operationPath("/api/control/orgs/:orgId/teams"),
    input: operationInput({ orgId: requiredParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "org.teams.create": defineOperation({
    method: "POST", path: operationPath("/api/control/orgs/:orgId/teams"),
    input: operationInput({ orgId: requiredParameter, name: bodyField }),
    output: withStrings("team_id", "name"), retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("name"),
  }),
  "org.ensureDefaultTeam": defineOperation({
    method: "POST", path: operationPath("/api/control/orgs/:orgId/ensure-default-team"),
    input: operationInput({ orgId: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
  "org.members.list": defineOperation({
    method: "GET", path: operationPath("/api/control/orgs/:orgId/members"),
    input: operationInput({ orgId: requiredParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "org.invitations.create": defineOperation({
    method: "POST", path: operationPath("/api/control/orgs/:orgId/invitations"),
    input: operationInput({ orgId: requiredParameter, email: bodyField, role: bodyField }),
    output: withStrings("message"), retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("email", "role"),
  }),
  "org.invitations.list": defineOperation({
    method: "GET", path: operationPath("/api/control/orgs/:orgId/invitations"),
    input: operationInput({ orgId: requiredParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: true },
  }),
  "org.invitations.revoke": defineOperation({
    method: "DELETE", path: operationPath("/api/control/orgs/:orgId/invitations/:invitationId"),
    input: operationInput({ orgId: requiredParameter, invitationId: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
  }),
  "org.invitations.accept": defineOperation({
    method: "POST", path: operationPath("/api/control/invitations/accept"),
    input: operationInput({ token: requiredParameter }),
    output: withStrings("user_id", "role"), retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("token"),
  }),
  "org.members.update": defineOperation({
    method: "PATCH", path: operationPath("/api/control/orgs/:orgId/members/:userPublicId"),
    input: operationInput({ orgId: requiredParameter, userPublicId: requiredParameter, role: bodyField }),
    output: withStrings("user_id", "role"), retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("role"),
  }),
  "org.members.remove": defineOperation({
    method: "DELETE", path: operationPath("/api/control/orgs/:orgId/members/:userPublicId"),
    input: operationInput({ orgId: requiredParameter, userPublicId: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
  "team.members.list": defineOperation({
    method: "GET", path: operationPath("/api/control/teams/:teamId/members"),
    input: operationInput({ teamId: requiredParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "team.members.add": defineOperation({
    method: "POST", path: operationPath("/api/control/teams/:teamId/members"),
    input: operationInput({ teamId: requiredParameter, tokenIdentifier: bodyField, providerSubject: bodyField, userPublicId: bodyField, role: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("tokenIdentifier", "providerSubject", "userPublicId", "role"),
  }),
  "team.members.remove": defineOperation({
    method: "DELETE", path: operationPath("/api/control/teams/:teamId/members"),
    input: operationInput({ teamId: requiredParameter, tokenIdentifier: bodyField, userPublicId: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("tokenIdentifier", "userPublicId"),
  }),
  "team.projects.list": defineOperation({
    method: "GET", path: operationPath("/api/control/teams/:teamId/projects"),
    input: operationInput({ teamId: requiredParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "team.projects.grant": defineOperation({
    method: "POST", path: operationPath("/api/control/teams/:teamId/projects"),
    input: operationInput({ teamId: requiredParameter, projectId: bodyField, role: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("projectId", "role"),
  }),
  "team.projects.revoke": defineOperation({
    method: "DELETE", path: operationPath("/api/control/teams/:teamId/projects"),
    input: operationInput({ teamId: requiredParameter, projectId: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("projectId"),
  }),
  "project.members.grant": defineOperation({
    method: "POST", path: operationPath("/api/control/projects/:projectId/members"),
    input: operationInput({ projectId: requiredParameter, userPublicId: bodyField, role: bodyField }),
    output: withStrings("project_id", "user_id", "role"), retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("userPublicId", "role"),
  }),
  "project.members.revoke": defineOperation({
    method: "DELETE", path: operationPath("/api/control/projects/:projectId/members/:userPublicId"),
    input: operationInput({ projectId: requiredParameter, userPublicId: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
  "project.access": defineOperation({
    method: "GET", path: operationPath("/api/control/projects/:projectId/access"),
    input: operationInput({ projectId: requiredParameter }),
    output: withArrays("entries"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "project.environment.list": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/projects/:projectId/environment"),
    input: operationInput({ projectId: requiredParameter }),
    output: withArrays("names"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "project.environment.set": defineOperation({
    method: "PUT", path: operationPath("/api/claxedo/projects/:projectId/environment/:name"),
    input: operationInput({ projectId: requiredParameter, name: requiredParameter, value: bodyField }),
    output: withArrays("names"), retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("value"),
  }),
  "project.environment.remove": defineOperation({
    method: "DELETE", path: operationPath("/api/claxedo/projects/:projectId/environment/:name"),
    input: operationInput({ projectId: requiredParameter, name: requiredParameter }),
    output: withArrays("names"), retry: "never",
    exposure: { renderer: true, app: false },
  }),
  "agentConfig.harness.options": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/agent-config/harness/options", { query: ["nativeHarness", "workspaceId"], optionalQuery: ["model"] }),
    input: operationInput({ nativeHarness: requiredParameter, workspaceId: requiredParameter, model: optionalParameter }),
    output: optional(withArrays("options")), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "connections.list": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/integrations"),
    input: operationInput({}),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "connections.connect": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/integrations/:id/connect"),
    input: operationInput({ id: requiredParameter, method: bodyField, fields: bodyField, secret: bodyField, confirmReplace: bodyField, scope: bodyField, issuer: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("method", "fields", "secret", "confirmReplace", "scope", "issuer"),
  }),
  "connections.attempt": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/integrations/attempts/:state"),
    input: operationInput({ state: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "connections.repositories": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/integrations/connections/:id/repositories"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "connections.disconnect": defineOperation({
    method: "DELETE", path: operationPath("/api/claxedo/integrations/connections/:id"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "connections.reverify": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/integrations/connections/:id/reverify"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
  "session.messages": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions/:sessionId/messages", { optionalQuery: ["workspaceId", "view", "limit", "before", "after"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: optionalParameter, view: optionalParameter, limit: optionalParameter, before: optionalParameter, after: optionalParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.outline": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions/:sessionId/outline", { optionalQuery: ["workspaceId", "rows", "cols", "reasoning", "shell", "edit"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: optionalParameter, rows: optionalParameter, cols: optionalParameter, reasoning: optionalParameter, shell: optionalParameter, edit: optionalParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.turnPage": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions/:sessionId/page", { query: ["workspaceId", "before", "rows", "cols", "reasoning", "shell", "edit"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: requiredParameter, before: requiredParameter, rows: requiredParameter, cols: requiredParameter, reasoning: requiredParameter, shell: requiredParameter, edit: requiredParameter }),
    output: withArrays("turns"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.part": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions/:sessionId/part", { query: ["workspaceId", "messageId", "partId"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: requiredParameter, messageId: requiredParameter, partId: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.gateway": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions/:sessionId/gateway", { optionalQuery: ["workspaceId"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: optionalParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  // Withheld from the renderer, with `workspace.unassignHost`: an assignment
  // names a host id the renderer must not choose. The supervisor supplies this
  // machine's own; the renderer's route is hostConnector.share.
  "workspace.assignHost": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:id/host-assignment"),
    input: operationInput({ id: requiredParameter, hostId: bodyField, displayName: bodyField, orgId: bodyField, projectId: bodyField, repoUrl: bodyField, repoName: bodyField, gitBranch: bodyField, remoteDirectory: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: false, app: false },
    body: selectBody("hostId", "displayName", "orgId", "projectId", "repoUrl", "repoName", "gitBranch", "remoteDirectory"),
  }),
  "workspace.unassignHost": defineOperation({
    method: "DELETE", path: operationPath("/api/workspace/:id/host-assignment"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: false, app: false },
  }),
  "telemetry.track": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/track"),
    input: operationInput({ event: requiredParameter, properties: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("event", "properties"),
  }),
  "plugin.request": defineOperation({
    method: (input) => input.method, path: operationPath("/api/plugins/:pluginId/*", { accepts: { pluginId: isPluginId } }),
    input: operationInput({ pluginId: requiredParameter, method: pluginMethod, path: requiredParameter, body: bodyField }),
    output: statusResult, retry: "never",
    exposure: { renderer: true, app: false },
    body: pluginBody,
    response: "http",
  }),
}

/** What a composed table reads of each operation, whichever table declared it. */
export type HostedOperation = Readonly<{
  input: Decoder<unknown>
  output: Decoder<unknown>
  retry: "safe" | "never"
  exposure: Readonly<{ renderer: boolean; app: boolean; stream?: boolean }>
  path: Readonly<{ pattern?: string }>
  request(raw: unknown): ResolvedRequest
}>

export type HostedOperations = Readonly<Record<string, HostedOperation>>

type CoreHostedOperations = typeof CORE_HOSTED_OPERATIONS
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never

/** The core operations and each plugin's, as one name space. */
export type ComposedHostedOperations<Extra extends readonly HostedOperations[]> = CoreHostedOperations & Intersection<Extra[number]>

export type HostedOperationName<T extends HostedOperations = CoreHostedOperations> = keyof T & string
export type RunHostedOperation<T extends HostedOperations = CoreHostedOperations> =
  (operation: HostedOperationName<T>, input?: Readonly<Record<string, unknown>>) => Promise<unknown>
export type HostedOperationInput<N extends HostedOperationName<T>, T extends HostedOperations = CoreHostedOperations> =
  T[N]["input"] extends Decoder<infer I> ? I : never
export type DecodedHostedResult<N extends HostedOperationName<T>, T extends HostedOperations = CoreHostedOperations> =
  T[N]["output"] extends Decoder<infer O> ? O : never

export type HostedOperationTable<T extends HostedOperations> = Readonly<{
  operations: T
  names: () => HostedOperationName<T>[]
  has: (name: string) => name is HostedOperationName<T>
  decode: <N extends HostedOperationName<T>>(name: N, raw: unknown) => DecodedHostedResult<N, T>
  isSafe: (name: HostedOperationName<T>) => boolean
  isStream: (name: string) => boolean
  resolve: (name: string, raw?: unknown) => ResolvedRequest
}>

/**
 * The operations one composition serves: the core table, then each plugin's.
 * A name two tables declare is refused, because the second would silently
 * replace a reviewed request with another.
 */
export function hostedOperationTable<const Extra extends readonly HostedOperations[]>(
  ...extra: Extra
): HostedOperationTable<ComposedHostedOperations<Extra>> {
  type T = ComposedHostedOperations<Extra>
  const declared = new Map<string, HostedOperation>(Object.entries(CORE_HOSTED_OPERATIONS))
  for (const table of extra) {
    for (const [name, operation] of Object.entries(table)) {
      if (declared.has(name)) throw new Error(`hosted operation "${name}" is declared twice`)
      declared.set(name, operation)
    }
  }
  const has = (name: string): name is HostedOperationName<T> => declared.has(name)
  const operation = (name: string): HostedOperation => {
    const found = declared.get(name)
    if (!found) throw new UnknownHostedOperation(`no hosted operation named "${name}"`)
    return found
  }
  // The loop above builds exactly `T`, and the decoder at `name` is
  // `T[N]["output"]`, but the checker follows neither through the generic.
  return {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    operations: Object.fromEntries(declared) as T,
    names: () => [...declared.keys()].filter(has),
    has,
    decode: <N extends HostedOperationName<T>>(name: N, raw: unknown) => {
      const decoded = operation(name).output(raw)
      if (!decoded.ok) throw new Error(`hosted operation "${name}" returned an unexpected shape: ${decoded.reason}`)
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      return decoded.value as DecodedHostedResult<N, T>
    },
    isSafe: (name) => operation(name).retry === "safe",
    isStream: (name) => declared.get(name)?.exposure.stream === true,
    resolve: (name, raw = {}) => {
      const resolving = operation(name)
      try {
        return resolving.request(raw)
      } catch (error) {
        if (error instanceof MissingOperationParameter) throw new MissingOperationParameter(`operation "${name}": ${error.message}`)
        throw error
      }
    },
  }
}
