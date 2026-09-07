import {
  type GitCommitSummary,
  type GitStatusEntry,
  type GitWorktreeStatus,
  WorkspaceRuntimeClientError,
} from "@claxedo/workspace-runtime/client"
import { asRecord } from "@claxedo/helpers/guards"
import { jsonRecord } from "@claxedo/helpers"

export type { GitCommitSummary, GitStatusEntry, GitWorktreeStatus }

/** The codes the runtime's git routes report; `WorkspaceGitError.code` carries whatever the runtime sent, so a new route code reaches the UI unrenamed. */
export type WorkspaceGitErrorCode =
  | "git_empty_message"
  | "git_nothing_staged"
  | "git_conflict"
  | "git_push_rejected"
  | "relay_role_denied"
  | "git_request_failed"

/** A failed git write as the runtime reported it: `code` is what the UI branches on, `message` is the git stderr when the runtime forwarded it. */
export class WorkspaceGitError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = "WorkspaceGitError"
  }
}

export function isWorkspaceGitError(error: unknown): error is WorkspaceGitError {
  return error instanceof WorkspaceGitError
}

/** The `git` namespace of the workspace runtime client this client drives. */
export type WorkspaceGitRuntime = {
  git: {
    status: () => Promise<GitWorktreeStatus>
    stage: (input: { paths: string[] }) => Promise<void>
    unstage: (input: { paths: string[] }) => Promise<void>
    commitStaged: (input: { message: string; amend?: boolean }) => Promise<{ commit: string }>
    push: (input: { setUpstream?: boolean }) => Promise<{ remote: string; branch: string }>
    log: (input?: { limit?: number }) => Promise<{ commits: GitCommitSummary[] }>
  }
}

export type WorkspaceGitClient = {
  status(): Promise<GitWorktreeStatus>
  stage(paths: string[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  commitStaged(input: { message: string; amend?: boolean }): Promise<{ commit: string }>
  push(input: { setUpstream?: boolean }): Promise<{ remote: string; branch: string }>
  log(input?: { limit?: number }): Promise<{ commits: GitCommitSummary[] }>
}

export function createWorkspaceGitClient(runtime: WorkspaceGitRuntime): WorkspaceGitClient {
  return {
    status: () => withGitError(() => runtime.git.status()),
    stage: (paths) => withGitError(() => runtime.git.stage({ paths })),
    unstage: (paths) => withGitError(() => runtime.git.unstage({ paths })),
    commitStaged: (input) => withGitError(() => runtime.git.commitStaged(input)),
    push: (input) => withGitError(() => runtime.git.push(input)),
    log: (input) => withGitError(() => runtime.git.log(input)),
  }
}

async function withGitError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof WorkspaceRuntimeClientError) throw workspaceGitError(error)
    throw error
  }
}

function workspaceGitError(error: WorkspaceRuntimeClientError) {
  const reported = asRecord(jsonRecord(error.body)?.error)
  const code = typeof reported?.code === "string" ? reported.code : "git_request_failed"
  const message = typeof reported?.message === "string" ? reported.message : error.message
  return new WorkspaceGitError(code, error.status, message)
}
