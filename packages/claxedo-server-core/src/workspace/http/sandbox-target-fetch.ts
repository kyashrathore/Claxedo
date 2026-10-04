import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import type { WorkspaceRuntimeClientOptions } from "./workspace-runtime-client"
import { createWorkspaceRuntimeClient } from "./workspace-runtime-client"

export type SandboxFetchOptions = WorkspaceRuntimeClientOptions

export async function sandboxFetch(
  ws: Workspace,
  path: string,
  init?: RequestInit,
  options: SandboxFetchOptions = {},
) {
  return createWorkspaceRuntimeClient({ workspace: ws, options }).request(path, init)
}
