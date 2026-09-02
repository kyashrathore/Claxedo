import type { SandboxFetchOptions } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import {
  createWorkspaceRuntimeClient,
  workspaceRuntimeRequestError,
} from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { WorkspaceRuntimeProtocolError } from "@claxedo/workspace-runtime/session-env-contract"

export type WorkspaceSessionAdmission = {
  directory: string
  worktree: string
  baseCommit: string
  leaseEpoch: number
}

export async function prepareWorkspaceRuntimeSession(input: {
  workspace: Workspace
  sessionId: string
  baseCommit?: string
  fetchOptions: SandboxFetchOptions
}): Promise<WorkspaceSessionAdmission> {
  const client = createWorkspaceRuntimeClient({ workspace: input.workspace, options: input.fetchOptions })
  const generation = await client.resolveGeneration()
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId,
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    }),
  }
  const response = generation
    ? await client.requestGeneration(generation, "/api/wr/worktrees", init)
    : await client.request("/api/wr/worktrees", init)
  if (!response.ok) throw await workspaceRuntimeRequestError("worktree admission", response)
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new WorkspaceRuntimeProtocolError("worktree admission", cause)
  }
  const worktree = record(body) ? body.worktree : undefined
  if (!record(worktree)) throw new WorkspaceRuntimeProtocolError("worktree admission")
  if (
    typeof worktree.path !== "string" ||
    typeof worktree.branch !== "string" ||
    typeof worktree.baseCommit !== "string"
  ) {
    throw new WorkspaceRuntimeProtocolError("worktree admission")
  }
  return {
    directory: worktree.path,
    worktree: worktree.branch,
    baseCommit: worktree.baseCommit,
    leaseEpoch: generation?.leaseEpoch ?? 0,
  }
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
