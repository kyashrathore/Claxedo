import type { Context } from "hono"
import { listProjects } from "@claxedo/server-core/workspace/store/index"
import { dispatchEmbedded, ingressOptions, requestWorkspace, type AdmittedProvenance, type IngressOptions, type RuntimeProxyOptions } from "./internals"
import { resolveIngressProvenance } from "./ingress-provenance"

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

// An access question that throws is unanswered rather than a failure of that
// workspace: reporting it would name a workspace the caller may not see.
async function admittedProvenance(c: Context, workspace: Workspace, options: IngressOptions): Promise<AdmittedProvenance | undefined> {
  try {
    const provenance = await resolveIngressProvenance(c.req.raw, workspace.id, options)
    return provenance.kind === "rejected" ? undefined : provenance
  } catch {
    return undefined
  }
}

async function readActivity(c: Context, workspace: Workspace, provenance: AdmittedProvenance): Promise<WorkspaceActivity> {
  const responses = await Promise.all(READS.map((path) => dispatchEmbedded(c, workspace, provenance, path)))
  if (responses.some((response) => response.status === 401 || response.status === 403)) return { kind: "refused" }
  const failed = responses.find((response) => !response.ok)
  if (failed) return { kind: "failed", workspaceId: workspace.id, status: failed.status, error: await failed.text() }
  const [status, permissions, questions] = await Promise.all(responses.map((response) => response.json()))
  return { kind: "read", workspaceId: workspace.id, status, permissions, questions }
}

// Access is decided before anything is read, with the same provenance each
// workspace's own routes ask for, so only a workspace this caller may read is
// ever named, in `workspaces` or in `failures`.
async function workspaceActivity(c: Context, workspace: Workspace, options: IngressOptions): Promise<WorkspaceActivity> {
  const provenance = await admittedProvenance(c, workspace, options)
  if (!provenance) return { kind: "refused" }
  try {
    return await readActivity(c, workspace, provenance)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: "failed", workspaceId: workspace.id, status: 503, error: JSON.stringify({ message }) }
  }
}

async function serveSessionActivity(c: Context, options: IngressOptions) {
  const settled = await Promise.all((await reachableLocalWorkspaces()).map((workspace) => workspaceActivity(c, workspace, options)))
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
