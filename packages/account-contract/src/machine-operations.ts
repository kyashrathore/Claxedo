import { defineOperation, operationPath, requiredParameter, optionalParameter, bodyField, stringListParameter, selectBody, connectedRepositoryBody } from "./operation-definition"
import { operationInput } from "./operation-input"
import { object, withStrings, withArrays } from "./hosted-output"

export const MACHINE_OPERATIONS = {
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
  "machines.rename": defineOperation({
    method: "PATCH", path: operationPath("/api/claxedo/remote-access/devices/:hostId"),
    input: operationInput({ hostId: requiredParameter, displayName: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => ({ display_name: input.displayName }),
  }),
  // The route replaces the whole list, and an assignment outside the roots
  // it is handed is retired in the same write.
  "machines.setRoots": defineOperation({
    method: "PATCH", path: operationPath("/api/claxedo/host/enrollments/:enrollmentId/scope"),
    input: operationInput({ enrollmentId: requiredParameter, roots: stringListParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => ({ allowed_roots: input.roots }),
  }),
  "machines.pair": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/pairings"),
    input: operationInput({}),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: () => ({}),
  }),
  "machines.invite": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/invitations"),
    input: operationInput({ folder: requiredParameter, displayName: optionalParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => ({ scope: { allowed_roots: [input.folder] }, sharesRoot: true, ...(input.displayName ? { displayName: input.displayName } : {}) }),
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
  // A repository cloned onto one of the person's own machines, into a folder
  // they chose there. A private one is fetched through the plane's broker on
  // a stand-in spent with the clone; the machine never holds the token.
  "machines.clone": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/machines/:enrollmentId/clone"),
    input: operationInput({ enrollmentId: requiredParameter, directory: bodyField, repoUrl: bodyField, connectionId: bodyField, repoFullName: bodyField }),
    output: withStrings("repoUrl", "directory"), retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => connectedRepositoryBody(selectBody("directory", "repoUrl", "connectionId", "repoFullName")(input)),
  }),
  // A new git worktree of a folder one of the person's machines serves, made
  // there on a `claxedo/<name>` branch; the app then assigns it with
  // `machines.assign` as a new workspace of that folder's project.
  "machines.worktree": defineOperation({
    method: "POST", path: operationPath("/api/claxedo/host/machines/:enrollmentId/worktree"),
    input: operationInput({ enrollmentId: requiredParameter, repository: bodyField, projectId: bodyField, name: bodyField, baseRef: bodyField }),
    output: withStrings("directory", "branch", "name"), retry: "never",
    exposure: { renderer: true, app: false },
    body: selectBody("repository", "projectId", "name", "baseRef"),
  }),
  // The route `claxedo host assign` uses, for a folder the person picked in
  // the app on one of their own machines: the plane refuses any other host,
  // and the folder joins that machine's roots. The app names a new workspace
  // id for each pick, so no existing workspace is re-pointed.
  "machines.assign": defineOperation({
    method: "POST", path: operationPath("/api/workspace/:workspaceId/host-assignment"),
    input: operationInput({ workspaceId: requiredParameter, hostId: bodyField, displayName: bodyField, repoName: bodyField, repoUrl: bodyField, remoteDirectory: bodyField, projectId: bodyField, gitBranch: bodyField }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
    body: (input) => ({ ...selectBody("hostId", "displayName", "repoName", "repoUrl", "remoteDirectory", "projectId", "gitBranch")(input), addRoot: true }),
  }),
  // The route `claxedo host unassign` uses: the person's own machine stops
  // serving the folder, the workspace is retired, and the folder stays there.
  "machines.unassign": defineOperation({
    method: "DELETE", path: operationPath("/api/workspace/:workspaceId/host-assignment"),
    input: operationInput({ workspaceId: requiredParameter }),
    output: object, retry: "never",
    exposure: { renderer: true, app: false },
  }),
}
