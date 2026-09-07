export { createWorkspaceRuntimeClient } from "./client/index"
export type { WorkspaceRuntimeClient, WorkspaceRuntimeConfigApplyOptions, WorkspaceRuntimeHealth } from "./client/index"
export {
  createWorkspaceRuntimeCaller,
  WorkspaceRuntimeClientError,
  WorkspaceRuntimeClientPayloadError,
  WorkspaceRuntimeClientTransportError,
  workspaceRuntimeClientError,
  namedMembers,
  without,
} from "./client/request"
export type {
  WorkspaceRuntimeCall,
  WorkspaceRuntimeCaller,
  WorkspaceRuntimeClientOptions,
  WorkspaceRuntimeRequestOptions,
  WorkspaceRuntimeResponse,
  WorkspaceRuntimeTransport,
  WorkspaceScope,
} from "./client/request"
export type {
  SessionCreateInput,
  SessionGoalStartInput,
  SessionInput,
  SessionListInput,
  SessionMessageInput,
  SessionMessagePageInput,
  SessionSummaryListInput,
  SessionUpdateInput,
  WorkspacePermissionClient,
  WorkspaceQuestionClient,
  WorkspaceSessionClient,
} from "./client/session"
export type {
  WorkspaceFileClient,
  WorkspaceFileContent,
  WorkspaceFileNode,
  WorkspaceFileSearchQuery,
  WorkspaceFileStatus,
  WorkspaceFilesClient,
  WorkspaceFindClient,
} from "./client/files"
export type {
  WorkspaceAgentClient,
  WorkspaceCommandClient,
  WorkspaceMcpClient,
  WorkspaceMcpStatus,
  WorkspaceVcsClient,
  WorkspaceVcsInfo,
} from "./client/workspace"
/**
 * The route inventory and write classification of the surface this client
 * calls. A consumer that has to decide per operation — which tool to expose,
 * which call a read-only credential may make — derives it from the runtime's
 * own table instead of copying one, which is what
 * `client/session-route-inventory.guard.test.ts` already pins the client
 * itself against. `errorBody` is the only value this pulls in, so the subpath
 * stays free of the runtime's server, pty and sqlite dependencies.
 */
export { SESSION_CORE_ROUTE_ACCESS, sessionAccessRequiresWrite } from "./session-access-policy"
export type { SessionAccessOperation } from "./session-access-policy"
