export const WorkspaceRuntimeApiPrefix = "/api/wr"

export const WorkspaceRuntimeRoutes = {
  health: `${WorkspaceRuntimeApiPrefix}/health`,
  capabilities: `${WorkspaceRuntimeApiPrefix}/capabilities`,
  config: `${WorkspaceRuntimeApiPrefix}/config`,
  harnessConfigOptions: `${WorkspaceRuntimeApiPrefix}/harness-config-options`,
  pty: `${WorkspaceRuntimeApiPrefix}/pty`,
  process: `${WorkspaceRuntimeApiPrefix}/process`,
  events: `${WorkspaceRuntimeApiPrefix}/events`,
  runtimeEvents: `${WorkspaceRuntimeApiPrefix}/runtime-events`,
  file: `${WorkspaceRuntimeApiPrefix}/file`,
  fileSearch: `${WorkspaceRuntimeApiPrefix}/find/file`,
  diff: `${WorkspaceRuntimeApiPrefix}/diff`,
  git: `${WorkspaceRuntimeApiPrefix}/git`,
  hook: `${WorkspaceRuntimeApiPrefix}/hook`,
  sessionEnv: `${WorkspaceRuntimeApiPrefix}/session-env`,
  workgraphConnectionBinding: "/api/workgraph/connection-binding",
  workgraphConnectionTools: "/api/workgraph/tools",
  workgraphAttemptBinding: "/api/workgraph/attempt-binding",
  workgraphAttemptTools: "/api/workgraph/attempt-tools",
} as const

export type WorkspaceRuntimeRouteFamily = keyof typeof WorkspaceRuntimeRoutes

export const WorkspaceRuntimeRouteManifest = Object.entries(WorkspaceRuntimeRoutes).map(([family, path]) => ({
  family: family as WorkspaceRuntimeRouteFamily,
  path,
}))

export function workspaceRuntimeRoute(path: string) {
  return WorkspaceRuntimeRouteManifest.find((item) => path === item.path || path.startsWith(item.path + "/"))
}
