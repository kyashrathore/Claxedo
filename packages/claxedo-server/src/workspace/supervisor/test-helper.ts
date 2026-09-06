import { runtimes, type WorkspaceRuntimeState } from "./store"

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
      kind: input.kind ?? "local",
      created_at: Date.now(),
      updated_at: Date.now(),
      ...(input.remote_directory ? { remote_directory: input.remote_directory } : {}),
    },
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
