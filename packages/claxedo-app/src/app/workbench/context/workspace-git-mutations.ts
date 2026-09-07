import { type Accessor, createSignal } from "solid-js"

import { useSDK } from "@/app/providers/sdk/sdk"
import { invalidateWorkspaceVcs } from "@/app/workbench/context/workspace-vcs-cache-honesty"

export type WorkspaceGitMutationKind = "stage" | "unstage" | "commit" | "push"

export type WorkspaceGitMutations = {
  stage(paths: string[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  commitStaged(input: { message: string; amend?: boolean }): Promise<{ commit: string }>
  push(input: { setUpstream?: boolean }): Promise<{ remote: string; branch: string }>
  pending: Accessor<WorkspaceGitMutationKind | undefined>
}

/**
 * Git writes for the SDK scope's worktree. Each write resolves only after the
 * event-owned VCS caches (git status and log, file status, review reads, the
 * runtime branch summary) have been invalidated, so a caller that awaits a
 * write observes the refreshed groups. Errors keep the runtime's `.code`.
 */
export function useWorkspaceGitMutations(): WorkspaceGitMutations {
  const sdk = useSDK()
  const [pending, setPending] = createSignal<WorkspaceGitMutationKind | undefined>()

  const write = async <T,>(kind: WorkspaceGitMutationKind, call: () => Promise<T>): Promise<T> => {
    setPending(kind)
    try {
      const result = await call()
      await invalidateWorkspaceVcs({ directory: sdk.directory, serverUrl: sdk.url, workspaceId: sdk.workspaceId })
      return result
    } finally {
      setPending(undefined)
    }
  }

  return {
    stage: (paths) => write("stage", () => sdk.git.stage(paths)),
    unstage: (paths) => write("unstage", () => sdk.git.unstage(paths)),
    commitStaged: (input) => write("commit", () => sdk.git.commitStaged(input)),
    push: (input) => write("push", () => sdk.git.push(input)),
    pending,
  }
}
