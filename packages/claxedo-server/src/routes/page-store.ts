import { randomUUID } from "node:crypto"
import { ClaxedoDB, and, desc, eq, inArray } from "../storage/db"
import { ClaxedoPageStatusTable, ClaxedoPageTable } from "../storage/schema"
import { migratePages } from "../storage/migrate-legacy"
import { getWorkspaceByDirectory, listProjects } from "../workspace-store"

export const GLOBAL_PROJECT = "__pages_global__"
export const LOCAL_ORG = "__local__"
export const ALL_PROJECTS = "*"

export type Page = {
  id: string
  org_id: string
  project_id: string
  title: string
  content: string
  visibility: string
  version: number
  status: string
  session_id: string | null
  directory: string | null
  source_kind: string | null
  source_repo_root: string | null
  source_repo_key: string | null
  source_path: string | null
  source_branch: string | null
  base_commit: string | null
  base_blob_sha: string | null
  base_tree_sha: string | null
  last_materialized_commit: string | null
  last_materialized_blob_sha: string | null
  last_commit_at: string | null
  last_commit_author_id: string | null
  commit_status: string
  created_at: string
  updated_at: string
}

export type PageView = Omit<Page, "project_id"> & {
  project_id: string | null
  project_name: string | null
  project_worktree: string | null
}

export type PageStatusDef = {
  id: string
  name: string
  color: string
  position: number
  transitions: string
}

export type PageRouteError = {
  code: string
  message: string
}

export type PageScope<Auth = unknown> = {
  orgId: string
  projectId: string
  directory?: string
  auth?: Auth
}

export type ResolvedPageScope<Auth = unknown> = {
  scope: PageScope<Auth>
  page: Page
}

const DEFAULT_STATUSES: Array<{ id: string; name: string; color: string; position: number; transitions: string[] }> = [
  { id: "draft", name: "Draft", color: "#6b7280", position: 0, transitions: ["in_review", "in_progress"] },
  { id: "in_review", name: "In Review", color: "#f59e0b", position: 1, transitions: ["in_progress", "draft"] },
  { id: "in_progress", name: "In Progress", color: "#3b82f6", position: 2, transitions: ["done", "in_review"] },
  { id: "done", name: "Done", color: "#22c55e", position: 3, transitions: ["archived", "in_progress"] },
  { id: "archived", name: "Archived", color: "#9ca3af", position: 4, transitions: ["draft"] },
]

const seededProjects = new Set<string>()

export function clean(value: unknown) {
  if (typeof value !== "string") return ""
  return value.trim()
}

export function pageError(code: string, message: string): PageRouteError {
  return { code, message }
}

export function errorBody(error: PageRouteError) {
  return { error }
}

export function pageNotFound() {
  return pageError("page_not_found", "Page not found")
}

export function projectRequired(scope: string) {
  return pageError("page_project_required", `project_id is required for signed ${scope} requests`)
}

export function ensureProject(pid: string, directory?: string) {
  migratePages(pid, directory)
  seedDefaultStatuses(pid)
}

export function isGlobalProject(pid: string) {
  return pid === GLOBAL_PROJECT
}

export async function resolveProject(input: { directory?: string; project_id?: string }) {
  const project_id = clean(input.project_id)
  if (project_id) return { pid: project_id, directory: clean(input.directory) || undefined }

  const directory = clean(input.directory)
  if (!directory) return { pid: GLOBAL_PROJECT, directory: undefined }

  const ws = await getWorkspaceByDirectory(directory)
  return {
    pid: clean(ws?.project_id) || GLOBAL_PROJECT,
    directory,
  }
}

export async function statusProject(input: { directory?: string; project_id?: string }) {
  return resolveProject(input)
}

export async function enrichPage(page: Page): Promise<PageView> {
  if (isGlobalProject((page as Page & { project_id?: string }).project_id || "")) {
    return {
      ...page,
      project_id: null,
      project_name: null,
      project_worktree: null,
    }
  }
  const map = await projectMap()
  const meta = map.get((page as Page & { project_id?: string }).project_id || "")
  return {
    ...page,
    project_id: (page as Page & { project_id?: string }).project_id || null,
    project_name: meta?.name || null,
    project_worktree: meta?.worktree || null,
  }
}

export async function enrichPages(rows: Page[]) {
  const map = await projectMap()
  return rows.map((page) => {
    const pid = (page as Page & { project_id?: string }).project_id || ""
    if (isGlobalProject(pid)) {
      return {
        ...page,
        project_id: null,
        project_name: null,
        project_worktree: null,
      } satisfies PageView
    }
    const meta = map.get(pid)
    return {
      ...page,
      project_id: pid || null,
      project_name: meta?.name || null,
      project_worktree: meta?.worktree || null,
    } satisfies PageView
  })
}

export function listPages(scope: PageScope): Page[] {
  ensureProject(scope.projectId, scope.directory)
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(and(eq(ClaxedoPageTable.org_id, scope.orgId), eq(ClaxedoPageTable.project_id, scope.projectId)))
      .orderBy(desc(ClaxedoPageTable.updated_at))
      .all(),
  )
}

export function listPagesAll(orgId: string): Page[] {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(eq(ClaxedoPageTable.org_id, orgId))
      .orderBy(desc(ClaxedoPageTable.updated_at))
      .all(),
  )
}

export function getPage(scope: PageScope, pageId: string): Page | undefined {
  ensureProject(scope.projectId, scope.directory)
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(and(
        eq(ClaxedoPageTable.id, pageId),
        eq(ClaxedoPageTable.org_id, scope.orgId),
        eq(ClaxedoPageTable.project_id, scope.projectId),
      ))
      .get(),
  )
}

export function getPageAny(orgId: string, pageId: string): Page | undefined {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(and(eq(ClaxedoPageTable.id, pageId), eq(ClaxedoPageTable.org_id, orgId)))
      .get(),
  )
}

export function createPage(
  pid: string,
  title?: string,
  opts?: {
    content?: string
    status?: string
    directory?: string
    org_id?: string
    source?: Partial<Pick<Page,
      | "source_kind"
      | "source_repo_root"
      | "source_repo_key"
      | "source_path"
      | "source_branch"
      | "base_commit"
      | "base_blob_sha"
      | "base_tree_sha"
      | "commit_status"
    >>
  },
): Page {
  ensureProject(pid, opts?.directory)
  const page: Page & { project_id: string } = {
    id: pageId(),
    org_id: opts?.org_id ?? LOCAL_ORG,
    project_id: pid,
    title: clean(title) || "Untitled",
    content: opts?.content ?? "",
    visibility: "project",
    version: 0,
    status: clean(opts?.status) || "draft",
    session_id: null,
    directory: opts?.directory || null,
    source_kind: opts?.source?.source_kind ?? null,
    source_repo_root: opts?.source?.source_repo_root ?? null,
    source_repo_key: opts?.source?.source_repo_key ?? null,
    source_path: opts?.source?.source_path ?? null,
    source_branch: opts?.source?.source_branch ?? null,
    base_commit: opts?.source?.base_commit ?? null,
    base_blob_sha: opts?.source?.base_blob_sha ?? null,
    base_tree_sha: opts?.source?.base_tree_sha ?? null,
    last_materialized_commit: null,
    last_materialized_blob_sha: null,
    last_commit_at: null,
    last_commit_author_id: null,
    commit_status: opts?.source?.commit_status ?? "draft",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  ClaxedoDB.use((db) => db.insert(ClaxedoPageTable).values(page).run())
  return page
}

export function listStatuses(pid: string, directory?: string): PageStatusDef[] {
  ensureProject(pid, directory)
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageStatusTable)
      .where(eq(ClaxedoPageStatusTable.project_id, pid))
      .orderBy(ClaxedoPageStatusTable.position)
      .all(),
  )
}

export function saveStatuses(pid: string, statuses: Array<{ id: string; name: string; color: string; position: number; transitions: string[] }>, directory?: string): PageStatusDef[] {
  ensureProject(pid, directory)
  const ids = statuses.map((s) => s.id)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate status IDs")
  for (const s of statuses) {
    for (const t of s.transitions) {
      if (!ids.includes(t)) throw new Error(`Transition target "${t}" does not exist`)
    }
  }

  const existing = listStatuses(pid, directory)
  const removedIds = existing.map((s) => s.id).filter((sid) => !ids.includes(sid))
  const fallbackStatus = statuses.length > 0 ? statuses.reduce((a, b) => (a.position < b.position ? a : b)).id : "draft"

  ClaxedoDB.transaction((db) => {
    if (removedIds.length) {
      db.update(ClaxedoPageTable)
        .set({ status: fallbackStatus, updated_at: new Date().toISOString() })
        .where(
          and(
            eq(ClaxedoPageTable.project_id, pid),
            inArray(ClaxedoPageTable.status, removedIds),
          ),
        )
        .run()
    }

    db.delete(ClaxedoPageStatusTable).where(eq(ClaxedoPageStatusTable.project_id, pid)).run()

    for (const s of statuses) {
      db.insert(ClaxedoPageStatusTable)
        .values({
          id: s.id,
          project_id: pid,
          name: s.name,
          color: s.color,
          position: s.position,
          transitions: JSON.stringify(s.transitions),
        })
        .run()
    }
  })

  return listStatuses(pid, directory)
}

export function transitionPageStatus(scope: PageScope, pageId: string, targetStatus: string): { page?: Page; error?: PageRouteError; status?: number } {
  const page = getPage(scope, pageId)
  if (!page) return { error: pageNotFound(), status: 404 }

  const statuses = listStatuses(scope.projectId)
  const target = statuses.find((s) => s.id === targetStatus)
  if (!target) return { error: pageError("page_status_not_found", `Status "${targetStatus}" does not exist`), status: 422 }

  const current = statuses.find((s) => s.id === page.status)
  if (current) {
    const allowed = JSON.parse(current.transitions) as string[]
    if (!allowed.includes(targetStatus)) {
      return {
        error: pageError("page_status_transition_not_allowed", `Transition from "${page.status}" to "${targetStatus}" is not allowed`),
        status: 422,
      }
    }
  }

  const now = new Date().toISOString()
  ClaxedoDB.use((db) =>
    db
      .update(ClaxedoPageTable)
      .set({ status: targetStatus, updated_at: now })
      .where(and(
        eq(ClaxedoPageTable.id, pageId),
        eq(ClaxedoPageTable.org_id, scope.orgId),
        eq(ClaxedoPageTable.project_id, scope.projectId),
      ))
      .run(),
  )
  return { page: { ...page, status: targetStatus, updated_at: now } }
}

export function getPageRow(scope: PageScope, pageId: string) {
  ensureProject(scope.projectId)
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(and(
        eq(ClaxedoPageTable.id, pageId),
        eq(ClaxedoPageTable.org_id, scope.orgId),
        eq(ClaxedoPageTable.project_id, scope.projectId),
      ))
      .get(),
  )
}

export function getPageRowAny(orgId: string, pageId: string) {
  return ClaxedoDB.use((db) =>
    db
      .select()
      .from(ClaxedoPageTable)
      .where(and(eq(ClaxedoPageTable.id, pageId), eq(ClaxedoPageTable.org_id, orgId)))
      .get(),
  )
}

export function mergeStatuses(rows: PageStatusDef[]) {
  const map = new Map<string, PageStatusDef>()
  for (const row of rows) {
    const prev = map.get(row.id)
    if (!prev || row.position < prev.position) map.set(row.id, row)
  }
  return [...map.values()].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
}

export function updatePage(scope: PageScope, pageId: string, patch: { title?: string; content?: string }, expectedVersion: number): Page | "conflict" | undefined {
  const row = getPageRow(scope, pageId)
  if (!row) return undefined

  const now = new Date().toISOString()

  const next: Page = {
    ...row,
    title: patch.title !== undefined ? patch.title : row.title,
    content: patch.content !== undefined ? patch.content : row.content,
    version: row.version + 1,
    updated_at: now,
  }
  const result = ClaxedoDB.raw()
    .prepare(
      `UPDATE claxedo_page
        SET title = ?, content = ?, version = ?, updated_at = ?
        WHERE id = ? AND org_id = ? AND project_id = ? AND version = ?`,
    )
    .run(
      next.title,
      next.content,
      next.version,
      next.updated_at,
      pageId,
      scope.orgId,
      scope.projectId,
      expectedVersion,
    ) as { changes: number }
  if (result.changes < 1) return "conflict"
  return next
}

export function pageVersionConflict(currentVersion: number) {
  return {
    error: pageError("page_version_conflict", "Page changed elsewhere"),
    currentVersion,
  }
}

export function pageVersionRequired() {
  return errorBody(
    pageError("page_version_required", "If-Match is required for page content/title updates"),
  )
}

export function ifMatchVersion(input?: string) {
  const value = input?.trim()
  if (!value) return
  const unquoted = value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value
  const version = Number(unquoted)
  return Number.isSafeInteger(version) && version >= 0 ? version : undefined
}

export function deletePage(scope: PageScope, pageId: string): boolean {
  ClaxedoDB.use((db) =>
    db
      .delete(ClaxedoPageTable)
      .where(and(
        eq(ClaxedoPageTable.id, pageId),
        eq(ClaxedoPageTable.org_id, scope.orgId),
        eq(ClaxedoPageTable.project_id, scope.projectId),
      ))
      .run(),
  )
  return true
}

async function projectMap() {
  const projects = await listProjects()
  return new Map(projects.map((item) => [item.id, item] as const))
}

function pageId() {
  return `page_${randomUUID().replaceAll("-", "")}`
}

function seedDefaultStatuses(pid: string) {
  if (seededProjects.has(pid)) return

  const count = ClaxedoDB.use((db) =>
    db
      .select({ id: ClaxedoPageStatusTable.id })
      .from(ClaxedoPageStatusTable)
      .where(eq(ClaxedoPageStatusTable.project_id, pid))
      .limit(1)
      .all(),
  )
  if (count.length > 0) {
    seededProjects.add(pid)
    return
  }

  ClaxedoDB.use((db) => {
    for (const s of DEFAULT_STATUSES) {
      db.insert(ClaxedoPageStatusTable)
        .values({
          id: s.id,
          project_id: pid,
          name: s.name,
          color: s.color,
          position: s.position,
          transitions: JSON.stringify(s.transitions),
        })
        .run()
    }
  })
  seededProjects.add(pid)
}
