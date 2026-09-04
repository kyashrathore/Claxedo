import { api } from "@/platform/api/api"
import { hostedControlCall } from "@/platform/account/hosted-control-call"
import { workspaceCreateUrl } from "@/platform/runtime/agent/workspace-control-routes"

export type CreateCloudWorkspaceResult = {
  workspaceId: string
  projectId?: string
  directory?: string
  workspaceBaseUrl?: string
  workspaceName?: string | null
  provider?: string
  kind?: string
  status?: string | null
}

export type CreateCloudWorkspaceInput = {
  projectId?: string
  projectName?: string
  workspaceName?: string
  repoUrl?: string
  connectionId?: string
  repo?: { fullName: string }
  /** Local control-plane driver picker only; hosted compose ignores this. */
  driver?: string
  gitBranch?: string
  baseUrl?: string
}

/**
 * Provision a cloud workspace on the control plane.
 *
 * Desktop signed mode: renderer has no bearer. Named `workspace.create` reaches
 * the hosted control plane through Electron main. Browser / unsigned keeps
 * `api.post` against the configured control-plane base URL.
 */
export async function createCloudWorkspace(
  input: CreateCloudWorkspaceInput,
): Promise<CreateCloudWorkspaceResult> {
  const params: Record<string, unknown> = {}
  if (input.projectId) params.projectId = input.projectId
  if (input.projectName) params.projectName = input.projectName
  if (input.workspaceName) params.workspaceName = input.workspaceName
  if (input.repoUrl) params.repoUrl = input.repoUrl
  if (input.connectionId && input.repo?.fullName) {
    params.connectionId = input.connectionId
    params.repoFullName = input.repo.fullName
  }

  return hostedControlCall(
    "workspace.create",
    params,
    async () => {
      const body: Record<string, unknown> = {}
      if (input.projectId) body.projectId = input.projectId
      if (input.projectName) body.projectName = input.projectName
      if (input.workspaceName) body.workspaceName = input.workspaceName
      if (input.repoUrl) body.repoUrl = input.repoUrl
      if (input.connectionId && input.repo) {
        body.connectionId = input.connectionId
        body.repo = input.repo
      }
      if (input.driver) body.driver = input.driver
      if (input.gitBranch) body.gitBranch = input.gitBranch

      return api.post<CreateCloudWorkspaceResult>(
        workspaceCreateUrl({ baseUrl: input.baseUrl }),
        body,
      )
    },
  )
}
