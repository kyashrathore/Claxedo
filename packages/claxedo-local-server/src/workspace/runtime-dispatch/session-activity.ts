import type { Context } from "hono"
import { listProjects } from "@claxedo/server-core/workspace/store/index"
import { embedded, ingressOptions, requestWorkspace, type IngressOptions, type RuntimeProxyOptions } from "./internals"

export const SESSION_ACTIVITY_PATH = "/api/wr/session-activity"

const READS = ["/session/status", "/permission", "/question"] as const

type Workspace = Awaited<ReturnType<typeof listProjects>>[number]["workspaces"][string]

type WorkspaceActivity =
  | { kind: "read"; workspaceId: string; status: unknown; permissions: unknown; questions: unknown }
  | { kind: "refused" }
  | { kind: "failed"; workspaceId: string; status: number; error: string }

async function reachableLocalWorkspaces(): Promise<Workspace[]> {
  const projects = await listProjects()
  return projects.flatMap((project) => Object.values(project.workspaces)).filter((workspace) => workspace.kind !== "cloud" && workspace.reachable)
}

// Every read goes through `embedded`, the per-workspace dispatch, so each
// workspace answers this caller exactly what its own routes would: the same
// ingress provenance, the same relay stamp, the same runtime refusals.
async function workspaceActivity(c: Context, workspace: Workspace, options: IngressOptions): Promise<WorkspaceActivity> {
  const responses = await Promise.all(READS.map((path) => embedded(c, workspace, path, options)))
  if (responses.some((response) => response.status === 401 || response.status === 403)) return { kind: "refused" }
  const failed = responses.find((response) => !response.ok)
  if (failed) return { kind: "failed", workspaceId: workspace.id, status: failed.status, error: await failed.text() }
  const [status, permissions, questions] = await Promise.all(responses.map((response) => response.json()))
  return { kind: "read", workspaceId: workspace.id, status, permissions, questions }
}

async function settledActivity(c: Context, workspace: Workspace, options: IngressOptions): Promise<WorkspaceActivity> {
  try {
    return await workspaceActivity(c, workspace, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: "failed", workspaceId: workspace.id, status: 503, error: JSON.stringify({ message }) }
  }
}

async function serveSessionActivity(c: Context, options: IngressOptions) {
  const settled = await Promise.all((await reachableLocalWorkspaces()).map((workspace) => settledActivity(c, workspace, options)))
  return c.json({
    workspaces: settled.flatMap(({ kind, ...item }) => (kind === "read" ? [item] : [])),
    failures: settled.flatMap(({ kind, ...item }) => (kind === "failed" ? [item] : [])),
  })
}

export function hostSessionActivity(c: Context, pathname: string, options: RuntimeProxyOptions) {
  if (pathname !== SESSION_ACTIVITY_PATH || c.req.method !== "GET") return undefined
  const named = requestWorkspace(c.req.raw)
  if (named.workspaceId !== undefined || named.directory) return undefined
  return serveSessionActivity(c, ingressOptions(options))
}
