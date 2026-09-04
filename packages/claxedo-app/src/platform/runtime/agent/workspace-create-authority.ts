export type HostedWorkspaceCreateInput = {
  projectId?: string
  projectName?: string
  workspaceName?: string
  repoUrl?: string
  gitBranch?: string
  driver?: string
  connectionId?: string
  repo?: { fullName: string }
  /** Variables the sandbox starts with (plaintext by design); omitted when empty. */
  env?: Record<string, string>
}

export type HostedWorkspaceCreateResult = {
  workspaceId: string
  directory?: string
  workspaceName?: string | null
  status?: string | null
}

export type WorkspaceCreateAuthority = (
  input: HostedWorkspaceCreateInput,
) => Promise<HostedWorkspaceCreateResult>

let authority: WorkspaceCreateAuthority | undefined

/** Bind the signed product's credential-owning workspace creation capability. */
export function configureWorkspaceCreateAuthority(next: WorkspaceCreateAuthority | undefined) {
  authority = next
}

export function createHostedWorkspace(input: HostedWorkspaceCreateInput) {
  if (!authority) throw new Error("Hosted workspace creation requires a signed account authority")
  return authority(input)
}
