export {
  sameSource,
  workspaceAgentExtensionRecords,
  type WorkspaceAgentExtensionRecord,
} from "@claxedo/agent-extensions"
import {
  mirrorWorkspaceAgentExtensionRecord as mirrorPackageWorkspaceAgentExtensionRecord,
  readMirroredWorkspaceAgentExtensions as readPackageMirroredWorkspaceAgentExtensions,
  removeMirroredWorkspaceAgentExtension as removePackageMirroredWorkspaceAgentExtension,
  resolveGitHubWorkspaceAgentExtension as resolvePackageGitHubWorkspaceAgentExtension,
  setMirroredWorkspaceAgentExtensionEnabled as setPackageMirroredWorkspaceAgentExtensionEnabled,
  type WorkspaceAgentExtensionRecord,
} from "@claxedo/agent-extensions"
import { dataDir } from "../lib/paths"

function withDataRoot<T extends { dataRoot?: string }>(input: T): T & { dataRoot: string } {
  return {
    ...input,
    dataRoot: input.dataRoot ?? dataDir(),
  }
}

export function resolveGitHubWorkspaceAgentExtension(
  input: Omit<Parameters<typeof resolvePackageGitHubWorkspaceAgentExtension>[0], "dataRoot"> & { dataRoot?: string },
) {
  return resolvePackageGitHubWorkspaceAgentExtension(withDataRoot(input))
}

export function mirrorWorkspaceAgentExtensionRecord(input: {
  workspaceId: string
  dataRoot?: string
  record: WorkspaceAgentExtensionRecord & { lock: NonNullable<WorkspaceAgentExtensionRecord["lock"]> }
  replaces?: string
}) {
  return mirrorPackageWorkspaceAgentExtensionRecord(withDataRoot(input))
}

export function readMirroredWorkspaceAgentExtensions(input: {
  workspaceId: string
  dataRoot?: string
}) {
  return readPackageMirroredWorkspaceAgentExtensions(withDataRoot(input))
}

export function setMirroredWorkspaceAgentExtensionEnabled(input: {
  workspaceId: string
  id: string
  enabled: boolean
  dataRoot?: string
  now?: number
}) {
  return setPackageMirroredWorkspaceAgentExtensionEnabled(withDataRoot(input))
}

export function removeMirroredWorkspaceAgentExtension(input: {
  workspaceId: string
  id: string
  dataRoot?: string
}) {
  return removePackageMirroredWorkspaceAgentExtension(withDataRoot(input))
}
