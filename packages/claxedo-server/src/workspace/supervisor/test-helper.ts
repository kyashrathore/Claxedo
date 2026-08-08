import { runtimes, type WorkspaceRuntimeState } from "./store"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

export function __registerReadyRuntimeForTest(input: {
  workspaceId: string
  url: string
  directory?: string
  kind?: "local" | "cloud"
  remote_directory?: string
}) {
  const fake: WorkspaceRuntimeState = {
    ws: {
      id: input.workspaceId,
      directory: input.directory ?? `/tmp/${input.workspaceId}`,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.remote_directory ? { remote_directory: input.remote_directory } : {}),
    } as Workspace,
    url: input.url,
    status: "ready",
    used_at: Date.now(),
    crashes: 0,
    retry_at: 0,
    active: 0,
    holds: [],
    ...(input.kind === "cloud" ? { remote: true } : {}),
  }
  runtimes.set(input.workspaceId, fake)
  return fake
}

export function __unregisterRuntimeForTest(workspaceId: string) {
  runtimes.delete(workspaceId)
}
