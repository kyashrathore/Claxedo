import { runtimeProviderCatalog } from "@claxedo/server-core/credentials/runtime-provider-catalog"
import type { Context } from "hono"
import { resolveWorkspace, workspaceIdFromDirectoryRef } from "@claxedo/server-core/workspace/store/index"
import { workspaceIdFromWorkspaceRef } from "@claxedo/server-core/workspace/refs"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"
import { WorkspaceRuntimeRequestError } from "@claxedo/server-core/workspace/http/workspace-runtime-client"
import { HTTPException } from "hono/http-exception"
import type { ProviderCatalogEntry } from "@claxedo/harness/contract"
import { sandboxFetchOptionsForRequest } from "../workspace/sandbox-fetch-options"
import type { AgentConfigRouteOptions } from "./route-options"

/**
 * The provider catalog of the workspace a request names, read from that
 * workspace's own engine. Undefined when there is no engine to ask: no
 * workspace is named (onboarding, Settings opened outside a project), or a
 * cloud workspace's sandbox is not running, which a catalog read never starts.
 */
export async function workspaceProviderCatalog(c: Context, options: AgentConfigRouteOptions, org: string): Promise<ProviderCatalogEntry[] | undefined> {
  const directory = c.req.query("directory") || c.req.header("x-claxedo-directory")
  const workspaceId = c.req.query("workspaceId") || c.req.query("workspace") || c.req.header("x-workspace-id")
    || workspaceIdFromWorkspaceRef(directory) || workspaceIdFromDirectoryRef(directory)
  if (!workspaceId && !directory) return undefined
  const workspace = await resolveWorkspace({ workspaceId, directory })
  if (!workspace) throw new HTTPException(404, { message: "An explicit registered workspace is required" })
  const access = await sandboxFetchOptionsForRequest(c.req.raw, workspace.id, options)
  if (options.authConfig?.enabled && (access.role !== "owner" || (access.orgId && access.orgId !== org))) {
    throw new HTTPException(403, { message: "Workspace owner required" })
  }
  const query = new URLSearchParams({ nativeHarness: "opencode", directory: workspace.directory })
  let response: Response
  try {
    response = await sandboxFetch(workspace, `/api/wr/harness-providers?${query}`, undefined,
      workspace.kind === "cloud" ? { ...access, resume: false } : access)
  } catch (error) {
    if (error instanceof WorkspaceRuntimeRequestError && (error.code === "sandbox_provisioning" || error.code === "sandbox_unavailable")) return undefined
    throw error
  }
  if (!response.ok) throw new Error(`Workspace provider catalog failed (${response.status})`)
  return runtimeProviderCatalog.parse(await response.json())
}
