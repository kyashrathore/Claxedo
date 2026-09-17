export const WorkspaceRuntimeApiPrefix = "/api/wr"

export const WorkspaceRuntimeRoutes = {
  health: `${WorkspaceRuntimeApiPrefix}/health`,
  capabilities: `${WorkspaceRuntimeApiPrefix}/capabilities`,
  config: `${WorkspaceRuntimeApiPrefix}/config`,
  harnessConfigOptions: `${WorkspaceRuntimeApiPrefix}/harness-config-options`,
  pty: `${WorkspaceRuntimeApiPrefix}/pty`,
  process: `${WorkspaceRuntimeApiPrefix}/process`,
  events: `${WorkspaceRuntimeApiPrefix}/events`,
  subagentTranscripts: `${WorkspaceRuntimeApiPrefix}/subagent-transcripts`,
  file: `${WorkspaceRuntimeApiPrefix}/file`,
  fileSearch: `${WorkspaceRuntimeApiPrefix}/find/file`,
  diff: `${WorkspaceRuntimeApiPrefix}/diff`,
  git: `${WorkspaceRuntimeApiPrefix}/git`,
  worktrees: `${WorkspaceRuntimeApiPrefix}/worktrees`,
  checkpoint: `${WorkspaceRuntimeApiPrefix}/checkpoint`,
  hook: `${WorkspaceRuntimeApiPrefix}/hook`,
} as const

export type WorkspaceRuntimeRouteFamily = keyof typeof WorkspaceRuntimeRoutes

function isRouteFamily(key: string): key is WorkspaceRuntimeRouteFamily {
  return key in WorkspaceRuntimeRoutes
}

// Built from the table's own keys through a predicate: `Object.keys` types them
// as `string`, and recognising each one keeps the family literal without
// claiming a shape the table has not been asked about.
export const WorkspaceRuntimeRouteManifest = Object.keys(WorkspaceRuntimeRoutes)
  .filter(isRouteFamily)
  .map((family) => ({ family, path: WorkspaceRuntimeRoutes[family] }))

export function workspaceRuntimeRoute(path: string) {
  return WorkspaceRuntimeRouteManifest.find((item) => path === item.path || path.startsWith(item.path + "/"))
}
