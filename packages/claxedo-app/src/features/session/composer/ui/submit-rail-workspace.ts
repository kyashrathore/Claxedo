import { workspaceKey, type SessionRef } from "@/platform/identity/session-ref"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { reconcileUpdatedSessionListQueryData, upsertCreatedSessionListRow } from "../../data/query/session-list"
import { projectForDirectory, projectId, type ProjectCatalogItem } from "../workspace-resolver"

type SessionDirectory = string

function publicWorkspaceId(value: string | undefined): string | undefined {
  return value && /^ws_/.test(value) ? value : undefined
}

/**
 * Workspace id stamped onto optimistic rail rows after create handoff.
 * Only public `ws_*` ids — never local association UUIDs that would duplicate
 * the row under both `local:` and `workspace:` sessionRefs.
 */
export function resolveCreatedSessionListWorkspaceId(input: {
  readonly sessionRef: SessionRef | undefined
  readonly workspaceId: string | undefined
  readonly sessionDirectory: string
}): string | undefined {
  // Prefer a concrete key from the session ref, but fall through when host is
  // "workspace" with no resolvable key (filesystem-backed localSessionRef on a
  // signed route) so the route-level `ws_*` input still wins.
  const fromRef =
    input.sessionRef?.host === "workspace" ? publicWorkspaceId(workspaceKey(input.sessionRef)) : undefined
  if (fromRef) return fromRef
  const fromRoute = publicWorkspaceId(input.workspaceId)
  if (fromRoute) return fromRoute
  return publicWorkspaceId(sessionWorkspaceRuntimeRef({ directory: input.sessionDirectory })?.workspaceId)
}

export function bumpCreatedSessionRail(input: {
  sessionId: string
  title: string
  directory: SessionDirectory
  sessionRef: SessionRef | undefined
  workspaceId: string | undefined
  projects: readonly ProjectCatalogItem[]
}) {
  const workspaceId = resolveCreatedSessionListWorkspaceId({
    sessionRef: input.sessionRef,
    workspaceId: input.workspaceId,
    sessionDirectory: input.directory,
  })
  const project = projectForDirectory(input.projects, input.directory)
    ?? (workspaceId ? projectForDirectory(input.projects, workspaceId) : undefined)
    ?? (workspaceId ? projectForDirectory(input.projects, `workspace:${workspaceId}`) : undefined)
  const resolvedProjectId = projectId(project)
  const createdAt = Date.now()
  upsertCreatedSessionListRow({
    row: {
      sessionId: input.sessionId,
      title: input.title,
      directory: input.directory,
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      createdAt,
      updatedAt: createdAt,
    },
  })
  reconcileUpdatedSessionListQueryData({
    sessionId: input.sessionId,
    directory: input.directory,
    ...(workspaceId ? { workspaceId } : {}),
    updatedAt: createdAt,
  })
}

export function bumpExistingSessionRail(input: {
  sessionId: string
  directory: SessionDirectory
  sessionRef: SessionRef | undefined
  workspaceId: string | undefined
}) {
  const workspaceId = resolveCreatedSessionListWorkspaceId({
    sessionRef: input.sessionRef,
    workspaceId: input.workspaceId,
    sessionDirectory: input.directory,
  })
  reconcileUpdatedSessionListQueryData({
    sessionId: input.sessionId,
    directory: input.directory,
    ...(workspaceId ? { workspaceId } : {}),
    updatedAt: Date.now(),
  })
}
