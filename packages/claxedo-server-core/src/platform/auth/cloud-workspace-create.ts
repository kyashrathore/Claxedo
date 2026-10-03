/** What a signed caller creates a cloud workspace from. */
export type CloudWorkspaceCreateArgs = {
  workspaceId: string
  orgId?: string
  projectId?: string
  displayName: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
  remoteDirectory?: string
  homeRegion?: string
  /** The code-host connection whose token clones this private repository on every boot. */
  repoConnectionId?: string
}

/** A creation for a resolved owner, whose organization and project are already known. */
export type RuntimeCloudWorkspaceCreateArgs = Omit<CloudWorkspaceCreateArgs, "orgId" | "projectId" | "repoConnectionId"> & {
  orgId: string
  projectId: string
}
