import z from "zod"
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

/**
 * The wire form of the result above, checked on whichever branch answered.
 *
 * `hostedControlCall` has two producers. `workspace.create`'s hosted decoder
 * proves `workspaceId` and `directory` are non-empty strings and stops there,
 * and `api.post` proves nothing; neither is a `CreateCloudWorkspaceResult`
 * until this parses one. The annotation ties the schema to the exported type,
 * so adding a field to one without the other is a compile error.
 */
const CreateCloudWorkspaceResultSchema: z.ZodType<CreateCloudWorkspaceResult> = z.object({
  workspaceId: z.string(),
  projectId: z.string().optional(),
  directory: z.string().optional(),
  workspaceBaseUrl: z.string().optional(),
  workspaceName: z.string().nullable().optional(),
  provider: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().nullable().optional(),
})

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

  const raw = await hostedControlCall(
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

      return api.post(
        workspaceCreateUrl({ baseUrl: input.baseUrl }),
        body,
      )
    },
  )
  const parsed = CreateCloudWorkspaceResultSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // The rejection reaches a toast, so it says what was wrong with the response
  // instead of carrying the issue list as serialized JSON.
  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
  throw new Error(`Workspace create returned an invalid response (${issues.join("; ")})`)
}
