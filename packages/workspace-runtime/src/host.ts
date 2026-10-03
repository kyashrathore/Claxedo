export {
  createWorkspaceHost,
  mountWorkspaceAgentHooks,
  mountWorkspaceCore,
  mountWorkspaceEvents,
  mountWorkspaceFiles,
  mountWorkspacePty,
} from "./workspace"
export type { WorkspaceHost, WorkspaceHostOptions } from "./workspace"
export { workspaceCapabilities } from "./capabilities"
export type { WorkspaceCapabilities, WorkspaceRpc } from "./capabilities"
export type { WorkspaceProfile } from "./profile"
export { Pty } from "./pty/index"
export { setupAgentHooks } from "./agent-hooks"
export { workspaceDir, workspaceId } from "./target"
export { currentSessionCore } from "./session-context"
export { workspaceRuntimeStoreDir } from "./env"
export { storeBackedSessionPlacement } from "./store-file"
export { WorkspaceWorktreeManager, workspaceStorageRoot } from "./worktree"
export { createBoundedGit, GIT_CLONE_TIMEOUT_MS, optionalGit, runGit, GitCredentialError, GitEnvironmentError, GitTimeoutError } from "./git"
export { buildSafeEnv } from "./pty/env"
export type { GitHttpCredential, GitRunOptions } from "./git"

export type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
