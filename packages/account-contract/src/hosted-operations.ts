import { isPluginId } from "@claxedo/plugin-api/id"
import { sharedSessions } from "./shared-sessions"
import {
  defineOperation, operationInput, operationPath, requiredParameter, optionalParameter, bodyField,
  selectBody, operationHeaders, pluginMethod, pluginBody, connectedRepositoryBody,
  type DecodeResult, type OperationDefinition, type ResolvedRequest,
  MissingOperationParameter, UnknownHostedOperation,
} from "./operation-definition"
import { object, withStrings, array, withArrays, sessionPeople, withRecord, nullable, connection, statusResult, desktopSessionCleanupGrant } from "./hosted-output"

export const HOSTED_OPERATIONS = {
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
  // Main installs this short-lived cleanup grant into its authenticated daemon.
  // Neither the grant nor a renderer-selected actor/origin may cross account IPC.
  "session.cleanup.grant.desktop": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/session-cleanup/grant/desktop"),
    input: operationInput({ orgId: optionalParameter }),
    output: desktopSessionCleanupGrant, retry: "never",
    exposure: { renderer: false, app: false },
    body: selectBody("orgId"),
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
  "workspace.list.provisioner": defineOperation({
    method: "GET", path: operationPath("/api/workspace?host=provisioner"),
    input: operationInput({}),
    output: withArrays("workspaces"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "workspace.list.machine": defineOperation({
    method: "GET", path: operationPath("/api/workspace?host=machine"),
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
    input: operationInput({ projectId: bodyField, workspaceName: bodyField, repoUrl: bodyField, gitBranch: bodyField, driver: bodyField, connectionId: bodyField, repoFullName: bodyField }),
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
    input: operationInput({ id: requiredParameter }),
    output: connection, retry: "safe",
    exposure: { renderer: true, app: false },
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
    input: operationInput({ workspaceId: requiredParameter, sessionId: requiredParameter, operationId: requiredParameter, title: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => ({ ...selectBody("workspaceId", "sessionId", "operationId", "title")(input), kind: "create" }),
  }),
  "session.list": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions", { query: ["workspaceId"] }),
    input: operationInput({ workspaceId: requiredParameter }),
    output: withArrays("sessions"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.page": defineOperation({
    method: "GET", path: operationPath("/api/control/session-list?scope=project", { query: ["projectId", "limit"], optionalQuery: ["sort", "after"] }),
    input: operationInput({ projectId: requiredParameter, limit: requiredParameter, sort: optionalParameter, after: optionalParameter }),
    output: withArrays("items"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.inventory": defineOperation({
    method: "GET", path: operationPath("/api/control/session-list?scope=all", { query: ["limit"], optionalQuery: ["sort", "after", "activity", "settled", "seen", "ownership", "dateField", "from", "until"] }),
    input: operationInput({ limit: requiredParameter, sort: optionalParameter, after: optionalParameter, activity: optionalParameter, settled: optionalParameter, seen: optionalParameter, ownership: optionalParameter, dateField: optionalParameter, from: optionalParameter, until: optionalParameter }),
    output: withArrays("items"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.reader": defineOperation({
    method: "POST", path: operationPath("/api/control/sessions/:sessionId/reader", { query: ["workspaceId"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: requiredParameter, kind: bodyField, generation: bodyField, activitySequence: bodyField, outcomeSequence: bodyField, revision: bodyField }),
    body: selectBody("kind", "generation", "activitySequence", "outcomeSequence", "revision"),
    output: object, retry: "never",
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
  "session.attention.history": defineOperation({
    method: "GET", path: operationPath("/api/control/session-attention", { optionalQuery: ["after", "limit"] }),
    input: operationInput({ after: optionalParameter, limit: optionalParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: true },
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
  "session.shares.list": defineOperation({
    method: "GET", path: operationPath("/api/control/sessions/:sessionId/shares", { query: ["workspaceId"] }),
    input: operationInput({ sessionId: requiredParameter, workspaceId: requiredParameter }),
    output: sessionPeople, retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "session.shares.grant": defineOperation({
    method: "POST", path: operationPath("/api/control/sessions/:sessionId/shares"),
    input: operationInput({ sessionId: requiredParameter, workspaceId: bodyField, level: bodyField, grantedToTokenIdentifier: bodyField, grantedToUserId: bodyField, grantedToTeamPublicId: bodyField, grantedToOrgId: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("workspaceId", "level", "grantedToTokenIdentifier", "grantedToUserId", "grantedToTeamPublicId", "grantedToOrgId"),
  }),
  "session.shares.revoke": defineOperation({
    method: "DELETE", path: operationPath("/api/control/sessions/:sessionId/shares"),
    input: operationInput({ sessionId: requiredParameter, workspaceId: bodyField, grantId: bodyField, grantedToTokenIdentifier: bodyField, grantedToTeamPublicId: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("workspaceId", "grantId", "grantedToTokenIdentifier", "grantedToTeamPublicId"),
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
  "documents.list": defineOperation({
    method: "GET", path: operationPath("/documents", { optionalQuery: ["project_id", "document_id", "directory", "archived"] }),
    input: operationInput({ project_id: optionalParameter, document_id: optionalParameter, directory: optionalParameter, archived: optionalParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: true },
  }),
  "documents.get": defineOperation({
    method: "GET", path: operationPath("/documents/:id"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: true },
  }),
  "documents.create": defineOperation({
    method: "POST", path: operationPath("/documents"),
    input: operationInput({ project_id: bodyField, directory: bodyField, display_name: bodyField, markdown: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("project_id", "directory", "display_name", "markdown"),
  }),
  "documents.update": defineOperation({
    method: "PATCH", path: operationPath("/documents/:id"),
    input: operationInput({ id: requiredParameter, display_name: bodyField, session_id: bodyField, ifMatch: optionalParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: true },
    body: selectBody("display_name", "session_id"),
    headers: operationHeaders({ ifMatch: "If-Match" }),
  }),
  "documents.content.get": defineOperation({
    method: "GET", path: operationPath("/documents/:id/content"),
    input: operationInput({ id: requiredParameter }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: true },
  }),
  "documents.content.put": defineOperation({
    method: "PUT", path: operationPath("/documents/:id/content"),
    input: operationInput({ id: requiredParameter, display_name: bodyField, markdown: bodyField, ifMatch: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("display_name", "markdown"),
    headers: operationHeaders({ ifMatch: "If-Match" }),
  }),
  "documents.snapshots": defineOperation({
    method: "GET", path: operationPath("/documents/:id/snapshots"),
    input: operationInput({ id: requiredParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: true },
  }),
  "documents.snapshots.restore": defineOperation({
    method: "POST", path: operationPath("/documents/:id/snapshots/:snapshotId/restore"),
    input: operationInput({ id: requiredParameter, snapshotId: requiredParameter, ifMatch: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
    headers: operationHeaders({ ifMatch: "If-Match" }),
  }),
  "documents.workSource": defineOperation({
    method: "POST", path: operationPath("/documents/:id/work-source"),
    input: operationInput({ id: requiredParameter, target_stream_id: bodyField, directory: bodyField, repository_url: bodyField }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
    body: selectBody("target_stream_id", "directory", "repository_url"),
  }),
  "documents.workSourcePin": defineOperation({
    method: "POST", path: operationPath("/documents/:id/snapshots/:snapshotId/work-source-pin"),
    input: operationInput({ id: requiredParameter, snapshotId: requiredParameter, work_source_id: bodyField, revision_id: bodyField }),
    output: object, retry: "safe",
    exposure: { renderer: true, app: false },
    body: selectBody("work_source_id", "revision_id"),
  }),
  "documents.statuses": defineOperation({
    method: "GET", path: operationPath("/documents/statuses", { optionalQuery: ["project_id", "document_id", "directory", "archived"] }),
    input: operationInput({ project_id: optionalParameter, document_id: optionalParameter, directory: optionalParameter, archived: optionalParameter }),
    output: array, retry: "safe",
    exposure: { renderer: true, app: true },
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
  "usage.cloudFacts": defineOperation({
    method: "GET", path: operationPath("/api/claxedo/usage/cloud-facts", { query: ["since", "until"] }),
    input: operationInput({ since: requiredParameter, until: requiredParameter }),
    output: withArrays("facts"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "documents.export": defineOperation({
    method: "GET", path: operationPath("/documents/:id/export"),
    input: operationInput({ id: requiredParameter }),
    output: withStrings("bytesBase64"), retry: "safe",
    exposure: { renderer: true, app: false },
  }),
  "documents.agentOpen": defineOperation({
    method: "POST", path: operationPath("/documents/:id/agent-open"),
    input: operationInput({ id: requiredParameter, session_id: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("session_id"),
  }),
  "documents.runtimeConflictResolve": defineOperation({
    method: "POST", path: operationPath("/documents/:id/runtime-conflict/resolve"),
    input: operationInput({ id: requiredParameter, session_id: bodyField, choice: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("session_id", "choice"),
  }),
  "documents.moveToRepository": defineOperation({
    method: "POST", path: operationPath("/documents/:id/move-to-repository"),
    input: operationInput({ id: requiredParameter, workspace_id: bodyField, path: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("workspace_id", "path"),
  }),
  "documents.fromRepo": defineOperation({
    method: "POST", path: operationPath("/documents/from-repo"),
    input: operationInput({ project_id: bodyField, directory: bodyField, workspace_id: bodyField, path: bodyField, display_name: bodyField, status: bodyField, session_id: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: true },
    body: selectBody("project_id", "directory", "workspace_id", "path", "display_name", "status", "session_id"),
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

export type HostedOperationName = keyof typeof HOSTED_OPERATIONS
export type RunHostedOperation = (operation: HostedOperationName, input?: Readonly<Record<string, unknown>>) => Promise<unknown>
export type HostedOperationInput<N extends HostedOperationName> =
  (typeof HOSTED_OPERATIONS)[N]["input"] extends (raw: unknown) => DecodeResult<infer I> ? I : never
export type DecodedHostedResult<N extends HostedOperationName> =
  (typeof HOSTED_OPERATIONS)[N]["output"] extends (raw: unknown) => DecodeResult<infer O> ? O : never

const OUTPUTS: { [N in HostedOperationName]: Pick<OperationDefinition<unknown, DecodedHostedResult<N>>, "output"> } = HOSTED_OPERATIONS

export function hostedOperationNames(): HostedOperationName[] {
  return Object.keys(HOSTED_OPERATIONS).filter(isHostedOperationName)
}

export function isHostedOperationName(value: string): value is HostedOperationName {
  return Object.hasOwn(HOSTED_OPERATIONS, value)
}

export function decodeHostedResult<N extends HostedOperationName>(name: N, raw: unknown): DecodedHostedResult<N> {
  const spec = OUTPUTS[name]
  if (!spec) throw new UnknownHostedOperation(`no hosted operation named "${name}"`)
  const decoded = spec.output(raw)
  if (!decoded.ok) throw new Error(`hosted operation "${name}" returned an unexpected shape: ${decoded.reason}`)
  return decoded.value
}

export function isSafeOperation(name: HostedOperationName) {
  return HOSTED_OPERATIONS[name].retry === "safe"
}

export function isStreamHostedOperation(name: string): name is HostedOperationName {
  return isHostedOperationName(name) && "stream" in HOSTED_OPERATIONS[name].exposure && HOSTED_OPERATIONS[name].exposure.stream === true
}

export function resolveHostedOperation(name: string, raw: unknown = {}): ResolvedRequest {
  if (!isHostedOperationName(name)) throw new UnknownHostedOperation(`no hosted operation named "${name}"`)
  try {
    return HOSTED_OPERATIONS[name].request(raw)
  } catch (error) {
    if (error instanceof MissingOperationParameter) throw new MissingOperationParameter(`operation "${name}": ${error.message}`)
    throw error
  }
}
