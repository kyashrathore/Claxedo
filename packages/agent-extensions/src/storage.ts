import { materializedRecordPath } from "./materialization"
import { lockStatePath } from "./lock"
import {
  agentExtensionStateRoot,
  installedStatePath,
  type AgentExtensionScope,
  type MaterializedAgentExtensionScope,
} from "./state"

export type AgentExtensionFiles = ReturnType<typeof agentExtensionFiles>

export function agentExtensionFiles(input: {
  scope: AgentExtensionScope
  projectDir?: string
  workspaceId?: string
  dataRoot?: string
}) {
  const root = agentExtensionStateRoot({
    scope: input.scope,
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
  })
  return {
    root,
    installed: installedStatePath({
      scope: input.scope,
      ...(input.projectDir ? { projectDir: input.projectDir } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
    }),
    lock: lockStatePath(root),
    materialized: materializedRecordPath(root),
  }
}

export function materializedAgentExtensionFiles(input: {
  scope: MaterializedAgentExtensionScope
  projectDir?: string
  dataRoot?: string
}) {
  return agentExtensionFiles(input)
}

export function workspaceAgentExtensionFiles(input: {
  workspaceId: string
  dataRoot?: string
}) {
  return agentExtensionFiles({
    scope: "workspace",
    workspaceId: input.workspaceId,
    ...(input.dataRoot ? { dataRoot: input.dataRoot } : {}),
  })
}
