import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { PageArenaRoutes, type PageArenaRouteOptions } from "./pages-arena"
import { ClaxedoDB, and, eq } from "../storage/db"
import { ClaxedoPageTable, ClaxedoPageStatusTable } from "../storage/schema"
import { resolveWorkspace, type Workspace } from "../workspace-store"
import { sandboxFetch, type SandboxFetchOptions } from "../sandbox-target-fetch"
import { markdownFromContent, markdownToDoc } from "./page-content"
import {
  ALL_PROJECTS,
  GLOBAL_PROJECT,
  LOCAL_ORG,
  clean,
  createPage,
  deletePage,
  enrichPage,
  enrichPages,
  errorBody,
  getPageAny,
  getPageRow,
  ifMatchVersion,
  listPages,
  listPagesAll,
  listStatuses,
  mergeStatuses,
  pageError,
  pageNotFound,
  pageVersionConflict,
  pageVersionRequired,
  projectRequired,
  resolveProject,
  saveStatuses,
  statusProject,
  transitionPageStatus,
  updatePage,
  type Page,
  type PageScope,
  type ResolvedPageScope,
} from "./page-store"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../control-plane/auth"
import type { ControlPlaneServices } from "../control-plane/services"
import { requireAuthority, type WorkspaceAuthority, type OrgId, type ProjectAction, type ProjectId } from "../control-plane/authority"
import { isLoopbackLocalRequest } from "./local-only-projection"
const pageListListeners = new Map<string, Set<(event: Record<string, unknown>) => void>>()

function pageListKey(orgId: string, projectId: string) {
  return `${orgId}\0${projectId}`
}

function subscribePageList(orgId: string, projectId: string, listener: (event: Record<string, unknown>) => void) {
  const key = pageListKey(orgId, projectId)
  const listeners = pageListListeners.get(key) ?? new Set()
  listeners.add(listener)
  pageListListeners.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) pageListListeners.delete(key)
  }
}

function emitPageList(orgId: string, projectId: string, reason: string) {
  const event = { type: "pages.changed", org_id: orgId, project_id: projectId, reason, ts: Date.now() }
  for (const key of [pageListKey(orgId, projectId), pageListKey(orgId, ALL_PROJECTS)]) {
    for (const listener of pageListListeners.get(key) ?? []) listener(event)
  }
}

export type PagesRouteOptions = PageArenaRouteOptions & {
  services?: ControlPlaneServices
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
  authority?: WorkspaceAuthority
}

type GitSnapshot = {
  repoRoot: string
  head: string
  branch: string
  blobSha: string
  tracked: boolean
  dirty: boolean
}

type GitCommitResult = {
  commit: string
  blobSha: string
}

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status })
}

async function runtimeJson<T>(res: Response): Promise<T | undefined> {
  return await res.json().catch(() => undefined) as T | undefined
}

async function gitSnapshot(ws: Workspace, sourcePath: string, options: SandboxFetchOptions) {
  return await sandboxFetch(ws, `/api/wr/git/snapshot?path=${encodeURIComponent(sourcePath)}`, undefined, options)
}

async function gitCommit(ws: Workspace, input: {
  path: string
  content: string
  message: string
  expected: { baseCommit?: string | null; baseBlobSha?: string | null }
}, options: SandboxFetchOptions) {
  return await sandboxFetch(ws, "/api/wr/git/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, options)
}

async function fileContent(ws: Workspace, sourcePath: string, options: SandboxFetchOptions) {
  return await sandboxFetch(ws, `/file/content?path=${encodeURIComponent(sourcePath)}`, undefined, options)
}

function routeAuthority(options: PagesRouteOptions) {
  // Per-route override first; otherwise the canonical services guard.
  if (options.authority) return options.authority
  return requireAuthority(options.services)
}

function sandboxFetchOptions(options: PagesRouteOptions): SandboxFetchOptions {
  return {
    ...(options.services?.sandbox.sandboxManager
      ? { sandboxManager: options.services.sandbox.sandboxManager }
      : {}),
    ...(options.services?.relay.provider ? { relayProvider: options.services.relay.provider } : {}),
    ...(options.services?.defaultHomeRegion ? { defaultHomeRegion: options.services.defaultHomeRegion } : {}),
  }
}

async function routeScope(c: any, options: PagesRouteOptions, action: ProjectAction, input: {
  projectId?: string
  directory?: string
} = {}): Promise<PageScope<SignedControlPlaneAuth> | Response> {
  const ref = await resolveProject({
    directory: input.directory ?? c.req.query("directory") ?? c.req.header("x-opencode-directory") ?? "",
    project_id: input.projectId ?? c.req.query("project_id"),
  })
  if (isLoopbackLocalRequest(c.req.raw)) {
    return {
      orgId: LOCAL_ORG,
      projectId: ref.pid,
      directory: ref.directory,
    }
  }
  const auth = await controlPlaneAuthContext(c.req.raw, {
    ...(options.authConfig ? { config: options.authConfig } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  if (auth.mode !== "signed") {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed Control Plane auth is required")
  }
  const authority = routeAuthority(options)
  await authority.usersMe(auth)
  const orgId = await authority.resolveOrgId(auth)
  const result = await authority.authorizeProject(auth, {
    orgId,
    projectId: ref.pid as ProjectId,
    action,
  })
  if (!result.ok) {
    return new Response(JSON.stringify(errorBody(pageNotFound())), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }
  return {
    orgId: result.orgId,
    projectId: ref.pid,
    directory: ref.directory,
    auth,
  }
}

async function routePageScope(request: Request, options: PagesRouteOptions, action: ProjectAction, pageId: string): Promise<ResolvedPageScope<SignedControlPlaneAuth> | Response> {
  if (isLoopbackLocalRequest(request)) {
    const page = getPageAny(LOCAL_ORG, pageId)
    if (!page) return pageNotFoundResponse()
    return {
      page,
      scope: {
        orgId: LOCAL_ORG,
        projectId: page.project_id,
        directory: page.directory ?? undefined,
      },
    }
  }

  const auth = await controlPlaneAuthContext(request, {
    ...(options.authConfig ? { config: options.authConfig } : {}),
    ...(options.verifier ? { verifier: options.verifier } : {}),
  })
  if (auth.mode !== "signed") {
    throw new ControlPlaneAuthError(401, "missing_bearer_token", "Signed Control Plane auth is required")
  }
  const authority = routeAuthority(options)
  await authority.usersMe(auth)
  const orgId = await authority.resolveOrgId(auth)
  const page = getPageAny(orgId, pageId)
  if (!page) return pageNotFoundResponse()
  const result = await authority.authorizeProject(auth, {
    orgId,
    projectId: page.project_id as ProjectId,
    action,
  })
  if (!result.ok) return pageNotFoundResponse()
  return {
    page,
    scope: {
      orgId: result.orgId,
      projectId: page.project_id,
      directory: page.directory ?? undefined,
      auth,
    },
  }
}

function pageNotFoundResponse() {
  return new Response(JSON.stringify(errorBody(pageNotFound())), {
    status: 404,
    headers: { "content-type": "application/json" },
  })
}

function authError(err: unknown) {
  if (err instanceof ControlPlaneAuthError) {
    return new Response(JSON.stringify(controlPlaneAuthErrorBody(err)), {
      status: err.status,
      headers: { "content-type": "application/json" },
    })
  }
}

// ── Routes ──

export function PagesRoutes(options: PagesRouteOptions = {}) {
  const arenaOptions = {
    ...options,
    authorizePage: async (request: Request, pageId: string, action: ProjectAction) => {
      const result = await routePageScope(request, options, action, pageId)
      if (result instanceof Response) return result
    },
  }
  return new Hono()
    .onError((err) => {
      const response = authError(err)
      if (response) return response
      throw err
    })
    .get("/statuses", async (c) => {
      const scope = clean(c.req.query("scope")) || "project"
      const project_id = clean(c.req.query("project_id"))
      const directory = clean(c.req.query("directory") || c.req.header("x-opencode-directory"))
      const authScope = await routeScope(c, options, "read", {
        projectId: scope === "global" ? GLOBAL_PROJECT : project_id,
        directory,
      })
      if (authScope instanceof Response) return authScope
      if (scope === "all" && !project_id && authScope.auth) {
        return c.json(errorBody(projectRequired("all-scope status list")), 400)
      }
      const pid = scope === "global" ? GLOBAL_PROJECT : (await statusProject({ directory, project_id })).pid
      const rows = (() => {
        if (scope === "global") return listStatuses(GLOBAL_PROJECT)
        if (scope === "all" && !project_id) {
          return mergeStatuses(
            ClaxedoDB.use((db) =>
              db
                .select()
                .from(ClaxedoPageStatusTable)
                .orderBy(ClaxedoPageStatusTable.position)
                .all(),
            ),
          )
        }
        return listStatuses(pid, directory)
      })()
      return c.json(rows.map((s) => ({ ...s, transitions: JSON.parse(s.transitions) as string[] })))
    })
    .put("/statuses", async (c) => {
      const scope = clean(c.req.query("scope")) || "project"
      const project_id = clean(c.req.query("project_id"))
      const directory = clean(c.req.query("directory") || c.req.header("x-opencode-directory"))
      if (scope === "all" && !project_id) {
        return c.json(errorBody(pageError("page_project_required", "project_id is required for all-scope status updates")), 400)
      }
      const authScope = await routeScope(c, options, "write", {
        projectId: scope === "global" ? GLOBAL_PROJECT : project_id,
        directory,
      })
      if (authScope instanceof Response) return authScope
      const pid = scope === "global" ? GLOBAL_PROJECT : (await statusProject({ directory, project_id })).pid
      const body = await c.req.json<Array<{ id: string; name: string; color: string; position: number; transitions: string[] }>>().catch(() => [])
      if (!Array.isArray(body) || body.length === 0) {
        return c.json(errorBody(pageError("page_statuses_invalid_body", "Expected non-empty array of statuses")), 400)
      }
      try {
        const saved = saveStatuses(pid, body, directory).map((s) => ({
          ...s,
          transitions: JSON.parse(s.transitions) as string[],
        }))
        return c.json(saved)
      } catch (err) {
        return c.json(
          errorBody(pageError("page_statuses_invalid", err instanceof Error ? err.message : "Invalid statuses")),
          422,
        )
      }
    })
    .get("/events", async (c) => {
      const scope = clean(c.req.query("scope")) || "project"
      const project_id = clean(c.req.query("project_id"))
      const directory = clean(c.req.query("directory") || c.req.header("x-opencode-directory"))
      const targetProject = scope === "global"
        ? GLOBAL_PROJECT
        : scope === "all" && !project_id
          ? ALL_PROJECTS
          : project_id
      const authScope = await routeScope(c, options, "read", { projectId: targetProject === ALL_PROJECTS ? undefined : targetProject, directory })
      if (authScope instanceof Response) return authScope
      if (targetProject === ALL_PROJECTS && authScope.auth) {
        return c.json(errorBody(projectRequired("all-scope event stream")), 400)
      }
      const projectId = targetProject === ALL_PROJECTS ? ALL_PROJECTS : authScope.projectId
      return streamSSE(c, async (stream) => {
        const unsub = subscribePageList(authScope.orgId, projectId, (event) => {
          void stream.writeSSE({ data: JSON.stringify(event) })
        })
        const hb = setInterval(() => {
          void stream.writeSSE({ data: JSON.stringify({ type: "pages.heartbeat" }) })
        }, 30000)
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            clearInterval(hb)
            unsub()
            resolve()
          })
        })
      })
    })
    .get("/", async (c) => {
      const scope = clean(c.req.query("scope")) || "project"
      const project_id = clean(c.req.query("project_id"))
      const directory = clean(c.req.query("directory") || c.req.header("x-opencode-directory"))
      const authScope = await routeScope(c, options, "read", { projectId: project_id, directory })
      if (authScope instanceof Response) return authScope
      if (scope === "all" && !project_id && authScope.auth) {
        return c.json(errorBody(projectRequired("all-scope page list")), 400)
      }
      const rows = (() => {
        if (scope === "global") return listPages({ ...authScope, projectId: GLOBAL_PROJECT })
        if (scope === "all") {
          const all = listPagesAll(authScope.orgId)
          if (!project_id) return all
          const target = project_id === "global" ? GLOBAL_PROJECT : project_id
          return all.filter((page) => (page as Page & { project_id?: string }).project_id === target)
        }
        return listPages(authScope)
      })()
      return c.json(await enrichPages(rows))
    })
    .post("/", async (c) => {
      const body = (await c.req.json<{ title?: string; content?: string; status?: string; directory?: string; project_id?: string }>().catch(() => ({}))) as { title?: string; content?: string; status?: string; directory?: string; project_id?: string }
      const authScope = await routeScope(c, options, "write", {
        directory: body.directory || c.req.query("directory") || c.req.header("x-opencode-directory") || "",
        projectId: body.project_id,
      })
      if (authScope instanceof Response) return authScope
      const page = createPage(authScope.projectId, body.title, {
        content: body.content,
        status: body.status,
        directory: authScope.directory,
        org_id: authScope.orgId,
      })
      emitPageList(authScope.orgId, authScope.projectId, "create")
      return c.json(await enrichPage(page), 201)
    })
    .post("/from-repo", async (c) => {
      type FromRepoBody = {
        title?: string
        status?: string
        directory?: string
        project_id?: string
        workspace_id?: string
        path?: string
      }
      const body = await c.req.json<FromRepoBody>().catch(() => ({} as FromRepoBody))
      const sourcePath = clean(body.path)
      if (!sourcePath) return c.json(errorBody(pageError("page_source_path_required", "path is required")), 400)
      const authScope = await routeScope(c, options, "write", {
        directory: body.directory || c.req.query("directory") || c.req.header("x-opencode-directory") || "",
        projectId: body.project_id,
      })
      if (authScope instanceof Response) return authScope
      const ws = await resolveWorkspace({ workspaceId: clean(body.workspace_id), directory: authScope.directory })
      if (!ws) return c.json(errorBody(pageError("workspace_not_found", "Workspace not found")), 404)
      const hostFetchOptions = sandboxFetchOptions(options)
      const snapshotRes = await gitSnapshot(ws, sourcePath, hostFetchOptions)
      if (snapshotRes.status === 409) return jsonResponse(await runtimeJson(snapshotRes) ?? {}, 409)
      if (!snapshotRes.ok) return jsonResponse(await runtimeJson(snapshotRes) ?? errorBody(pageError("git_source_snapshot_failed", "Git snapshot failed")), snapshotRes.status)
      const snapshot = await runtimeJson<GitSnapshot>(snapshotRes)
      if (!snapshot) return c.json(errorBody(pageError("git_source_snapshot_invalid", "Git snapshot response was invalid")), 502)
      const contentRes = await fileContent(ws, sourcePath, hostFetchOptions)
      if (!contentRes.ok) return jsonResponse(await runtimeJson(contentRes) ?? errorBody(pageError("git_source_read_failed", "Source file read failed")), contentRes.status)
      const file = await runtimeJson<{ type?: string; content?: string }>(contentRes)
      if (file?.type !== "text" || typeof file.content !== "string") {
        return c.json(errorBody(pageError("git_source_not_text", "Source file is not text")), 415)
      }
      const page = createPage(authScope.projectId, body.title || sourcePath.split("/").at(-1), {
        content: JSON.stringify(markdownToDoc(file.content)),
        status: body.status,
        directory: authScope.directory,
        org_id: authScope.orgId,
        source: {
          source_kind: "git",
          source_repo_root: snapshot.repoRoot,
          source_repo_key: ws.id,
          source_path: sourcePath,
          source_branch: snapshot.branch,
          base_commit: snapshot.head,
          base_blob_sha: snapshot.blobSha,
          commit_status: "sourced",
        },
      })
      emitPageList(authScope.orgId, authScope.projectId, "source")
      return c.json(await enrichPage(page), 201)
    })
    .get("/:id/export", async (c) => {
      const resolved = await routePageScope(c.req.raw, options, "read", c.req.param("id"))
      if (resolved instanceof Response) return resolved
      const { markdown } = markdownFromContent(resolved.page.content)
      return new Response(markdown, {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="${resolved.page.id}.md"`,
        },
      })
    })
    .patch("/:id/session", async (c) => {
      const body = (await c.req.json<{ session_id?: string | null }>().catch(() => ({}))) as { session_id?: string | null }
      const resolved = await routePageScope(c.req.raw, options, "write", c.req.param("id"))
      if (resolved instanceof Response) return resolved
      const sessionId = body.session_id !== undefined ? (body.session_id || null) : null
      ClaxedoDB.use((db) =>
        db
          .update(ClaxedoPageTable)
          .set({ session_id: sessionId })
          .where(and(
            eq(ClaxedoPageTable.id, resolved.page.id),
            eq(ClaxedoPageTable.org_id, resolved.scope.orgId),
            eq(ClaxedoPageTable.project_id, resolved.page.project_id),
          ))
          .run(),
      )
      emitPageList(resolved.scope.orgId, resolved.page.project_id, "session")
      return c.json(await enrichPage(getPageAny(resolved.scope.orgId, c.req.param("id"))!))
    })
    .post("/:id/status", async (c) => {
      const body = (await c.req.json<{ status?: string }>().catch(() => ({}))) as { status?: string }
      const target = clean(body.status)
      if (!target) return c.json(errorBody(pageError("page_status_required", "status is required")), 400)
      const resolved = await routePageScope(c.req.raw, options, "write", c.req.param("id"))
      if (resolved instanceof Response) return resolved
      const result = transitionPageStatus(resolved.scope, c.req.param("id"), target)
      if (result.error) return c.json(errorBody(result.error), (result.status ?? 422) as 404 | 422)
      emitPageList(resolved.scope.orgId, resolved.page.project_id, "status")
      return c.json(await enrichPage(result.page!))
    })
    .post("/:id/git/commit", async (c) => {
      const body = await c.req.json<{ message?: string }>().catch(() => ({} as { message?: string }))
      const resolved = await routePageScope(c.req.raw, options, "write", c.req.param("id"))
      if (resolved instanceof Response) return resolved
      const row = resolved.page
      if (!row.source_path || !row.base_commit || !row.base_blob_sha) {
        return c.json(errorBody(pageError("page_not_sourced", "Page is not linked to a git source")), 409)
      }
      const ws = await resolveWorkspace({ workspaceId: row.source_repo_key ?? undefined, directory: row.directory ?? undefined })
      if (!ws) return c.json(errorBody(pageError("workspace_not_found", "Workspace not found")), 404)
      const commitMessage = clean(body.message) || `Update ${row.title}`
      const commitRes = await gitCommit(ws, {
        path: row.source_path,
        content: markdownFromContent(row.content).markdown,
        message: commitMessage,
        expected: {
          baseCommit: row.base_commit,
          baseBlobSha: row.base_blob_sha,
        },
      }, sandboxFetchOptions(options))
      if (commitRes.status === 409) return jsonResponse(await runtimeJson(commitRes) ?? {}, 409)
      if (!commitRes.ok) return jsonResponse(await runtimeJson(commitRes) ?? errorBody(pageError("git_commit_failed", "Git commit failed")), commitRes.status)
      const committed = await runtimeJson<GitCommitResult>(commitRes)
      if (!committed?.commit || !committed.blobSha) {
        return c.json(errorBody(pageError("git_commit_invalid", "Git commit response was invalid")), 502)
      }
      ClaxedoDB.use((db) =>
        db
          .update(ClaxedoPageTable)
          .set({
            last_materialized_commit: committed.commit,
            last_materialized_blob_sha: committed.blobSha,
            last_commit_at: new Date().toISOString(),
            last_commit_author_id: resolved.scope.auth?.user.subject ?? null,
            base_commit: committed.commit,
            base_blob_sha: committed.blobSha,
            commit_status: "committed",
            updated_at: new Date().toISOString(),
          })
          .where(and(
            eq(ClaxedoPageTable.id, row.id),
            eq(ClaxedoPageTable.org_id, resolved.scope.orgId),
            eq(ClaxedoPageTable.project_id, row.project_id),
          ))
          .run(),
      )
      emitPageList(resolved.scope.orgId, row.project_id, "commit")
      return c.json(await enrichPage(getPageAny(resolved.scope.orgId, row.id)!))
    })
    .route("/:id/arena", PageArenaRoutes(arenaOptions))
    .get("/:id", async (c) => {
      const resolved = await routePageScope(c.req.raw, options, "read", c.req.param("id"))
      if (resolved instanceof Response) return resolved
      return c.json(await enrichPage(resolved.page))
    })
    .patch("/:id", async (c) => {
      const body = await c.req.json<{ title?: string; content?: string }>().catch(() => ({}))
      const resolved = await routePageScope(c.req.raw, options, "write", c.req.param("id"))
      if (resolved instanceof Response) return resolved
      const row = resolved.page
      const expectedVersion = ifMatchVersion(c.req.header("if-match"))
      if (expectedVersion === undefined) return c.json(pageVersionRequired(), 428)
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        return c.json(pageVersionConflict(row.version), 409)
      }
      const page = updatePage(resolved.scope, c.req.param("id"), body, expectedVersion)
      if (!page) return c.json(errorBody(pageNotFound()), 404)
      if (page === "conflict") {
        const current = getPageRow(resolved.scope, c.req.param("id"))
        return c.json(pageVersionConflict(current?.version ?? row.version), 409)
      }
      emitPageList(resolved.scope.orgId, row.project_id, "update")
      return c.json(await enrichPage(page))
    })
    .delete("/:id", async (c) => {
      const resolved = await routePageScope(c.req.raw, options, "admin", c.req.param("id"))
      if (resolved instanceof Response) return resolved
      const removed = deletePage(resolved.scope, c.req.param("id"))
      if (!removed) return c.json(errorBody(pageNotFound()), 404)
      emitPageList(resolved.scope.orgId, resolved.page.project_id, "delete")
      return c.json({ ok: true })
    })
}
