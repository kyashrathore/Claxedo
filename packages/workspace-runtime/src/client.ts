export { createWorkspaceRuntimeClient } from "./client/index"
export { terminalCheckpointSchema, applyTerminalCheckpointState, TERMINAL_SCROLLBACK_ROWS } from "./pty/terminal-checkpoint-state"
export type { TerminalCheckpoint } from "./pty/terminal-checkpoint-state"
export type { GitCommitSummary, GitStatusEntry, GitWorktreeStatus } from "./workspace-files/git-worktree"
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
 * calls, so a consumer deciding per operation — which tool to expose, which
 * call a read-only credential may make — derives it from the runtime's own
 * table instead of copying one.
 *
 * This entry is bundled with `--platform=browser`, so the reachable closure
 * must stay free of node builtins; that is why the envelope it pulls in comes
 * from `routes/error-body` rather than `routes/http`.
 */
export { SESSION_CORE_ROUTE_ACCESS, sessionAccessRequiresWrite } from "./session-access-policy"
export type { SessionAccessOperation } from "./session-access-policy"
