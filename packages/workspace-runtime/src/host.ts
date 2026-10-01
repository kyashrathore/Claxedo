export { createSpawnService } from "./spawn-service"

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
export {
  workspaceDir,
  workspaceId,
  assertTarget,
  registeredWorkspaceDirectory,
} from "./target"
export { workspaceRuntimeStoreDir } from "./env"
export { WorkspaceWorktreeManager, workspaceStorageRoot } from "./worktree"
export { createBoundedGit, optionalGit, runGit, GitCredentialError, GitEnvironmentError, GitTimeoutError } from "./git"
export { buildSafeEnv } from "./pty/env"
export type { GitHttpCredential, GitRunOptions } from "./git"

export type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
