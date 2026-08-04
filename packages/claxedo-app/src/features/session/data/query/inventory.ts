import type { Project } from "@opencode-ai/sdk/v2/client"
import type { GlobalSessionItem } from "./types"
import { normalizeSessionTurnOutcome, type ClaxedoSession } from "../session-types"
import { cmp } from "@/platform/query/sort"

function rec(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function txt(input: unknown) {
  return typeof input === "string" ? input : undefined
}

function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function workspaceDirectory(row: Record<string, unknown>) {
  const workspaceId = txt(row.workspace_id) ?? txt(row.workspaceId)
  return txt(row.remote_directory) ??
    txt(row.remoteDirectory) ??
    txt(row.directory) ??
    (workspaceId ? `workspace:${workspaceId}` : "/workspace")
}

function workspaceRepoUrl(row: Record<string, unknown>) {
  return txt(row.repo_url) ?? txt(row.repoUrl) ?? txt(row.git_remote) ?? txt(row.gitRemote)
}

/**
 * "owner/repo" from a git remote — the same derivation
 * `app/workbench/rail/rail-git-remote.ts` uses for the rail's project label.
 * Inlined rather than imported: `features/session` may not import `@/app/*`
 * (src/features/session/AGENTS.md).
 */
function ownerRepo(remote: string | undefined) {
  if (!remote) return undefined
  return remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
}

/**
 * The PROJECT's name. `display_name` is the WORKSPACE name and the hosted
 * create dialog posts `workspaceName: "main"`, so preferring it labelled every
 * hosted cloud project "main"; the repo identity is what actually names the
 * project. Falls through to the project id, never to the directory — a hosted
 * cloud workspace's directory is the literal string "/workspace".
 */
function projectDisplayName(row: Record<string, unknown>, projectID: string) {
  return txt(row.project_name) ??
    txt(row.projectName) ??
    txt(row.repo_name) ??
    txt(row.repoName) ??
    ownerRepo(workspaceRepoUrl(row)) ??
    txt(row.display_name) ??
    txt(row.displayName) ??
    projectID
}

function workspaceHosting(row: Record<string, unknown>) {
  const access = txt(row.access)
  if (access === "cloud" || access === "user-hosted") return access
  const backing = txt(row.backing)
  if (backing === "cloud" || backing === "user-hosted") return backing
  return undefined
}

export function signedInventoryProjects(input: { workspaces: unknown[] }) {
  const groups = new Map<string, {
    id: string
    name: string
    directories: string[]
    workspaces: Record<string, unknown>
    created: number
    updated: number
  }>()
  for (const workspace of input.workspaces) {
    const row = rec(workspace)
    if (!row) continue
    const workspaceId = txt(row?.workspace_id) ?? txt(row?.workspaceId)
    if (!workspaceId) continue
    const directory = workspaceDirectory(row)
    const projectID = txt(row?.project_id) ?? txt(row?.projectID) ?? workspaceId
    const workspaceName = txt(row?.workspace_name) ??
      txt(row?.workspaceName) ??
      txt(row?.display_name) ??
      txt(row?.displayName) ??
      workspaceId
    const created = num(row?.created_at) ?? num(row?.createdAt) ?? 0
    const updated = num(row?.updated_at) ?? num(row?.updatedAt) ?? created
    const group = groups.get(projectID) ?? {
      id: projectID,
      name: projectDisplayName(row, projectID),
      directories: [],
      workspaces: {},
      created,
      updated,
    }
    // Rows within a project are not uniform: only some carry repo identity. A
    // group opened by a bare row still has the raw project id as its name, so
    // let a later row that DOES know the repo upgrade it.
    if (group.name === projectID) group.name = projectDisplayName(row, projectID)
    group.directories.push(directory)
    group.created = Math.min(group.created, created)
    group.updated = Math.max(group.updated, updated)
    group.workspaces[directory] = {
      id: workspaceId,
      workspaceId,
      kind: txt(row?.access) ?? txt(row?.backing) ?? "cloud",
      workspace_name: workspaceName,
      directory,
      repo_url: workspaceRepoUrl(row),
      repo_name: txt(row?.repo_name) ?? txt(row?.repoName),
    }
    groups.set(projectID, group)
  }
  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    worktree: group.directories[0] ?? group.id,
    sandboxes: group.directories,
    workspaces: group.workspaces,
    time: {
      created: group.created,
      updated: group.updated,
    },
  })) as Array<Project & { workspaces?: Record<string, unknown> }>
}

export function mergeSignedInventoryProjects(existing: Project[], signed: Project[]) {
  if (signed.length === 0) return existing
  const signedByID = new Map(signed.map((project) => [project.id, project]))
  const seen = new Set<string>()
  const merged = existing.map((project) => {
    const signedProject = signedByID.get(project.id)
    if (!signedProject) return project
    seen.add(project.id)
    const signedWorkspaces = (signedProject as Project & { workspaces?: Record<string, unknown> }).workspaces ?? {}
    const projectWorkspaces = (project as Project & { workspaces?: Record<string, unknown> }).workspaces ?? {}
    return {
      ...project,
      // `project.name ?? …` alone kept a PLACEHOLDER name: both groupings fall
      // back to the raw project id when a row carries no repo identity, and an
      // id is a present-but-meaningless string that `??` happily preserves —
      // so a real repo-derived name arriving on the signed side lost to it.
      name: (project.name && project.name !== project.id ? project.name : undefined) ?? signedProject.name,
      sandboxes: [...new Set([...(project.sandboxes ?? []), ...(signedProject.sandboxes ?? [])])],
      workspaces: {
        ...projectWorkspaces,
        ...signedWorkspaces,
      },
      time: {
        created: Math.min(project.time?.created ?? signedProject.time.created, signedProject.time.created),
        updated: Math.max(project.time?.updated ?? signedProject.time.updated, signedProject.time.updated),
        initialized: project.time?.initialized ?? signedProject.time.initialized,
      },
    }
  })
  return [
    ...merged,
    ...signed.filter((project) => !seen.has(project.id)),
  ]
}

export function signedInventoryItems(input: { workspaces: unknown[]; sessionsByWorkspace: Record<string, unknown[]> }) {
  return input.workspaces.flatMap((workspace) => {
    const row = rec(workspace)
    if (!row) return []
    const workspaceId = txt(row?.workspace_id) ?? txt(row?.workspaceId)
    if (!workspaceId) return []
    const directory = workspaceDirectory(row)
    const projectID = txt(row?.project_id) ?? txt(row?.projectID) ?? workspaceId
    return (input.sessionsByWorkspace[workspaceId] ?? []).flatMap((session) => {
      const item = rec(session)
      const id = txt(item?.session_id) ?? txt(item?.sessionID) ?? txt(item?.id)
      if (!id) return []
      const created = num(item?.created_at) ?? num(item?.createdAt) ?? 0
      const updated = num(item?.updated_at) ?? num(item?.updatedAt) ?? created
      const lastTurn = normalizeSessionTurnOutcome(item?.lastTurn)
      return [{
        id,
        title: txt(item?.title) ?? id,
        directory,
        workspaceId,
        workspaceName: txt(row?.workspace_name) ??
          txt(row?.workspaceName) ??
          txt(row?.display_name) ??
          txt(row?.displayName),
        projectID,
        tags: [],
        attachments: [],
        environment: {
          kind: workspaceHosting(row),
          driver: txt(row?.backing) ?? txt(row?.access),
        },
        ...(lastTurn ? { lastTurn } : {}),
        time: { created, updated },
      } satisfies GlobalSessionItem]
    })
  })
}

export function mapInventoryToSessions(items: GlobalSessionItem[]) {
  return items
    .filter((item) => !item.archived)
    .map((item) => ({
      id: item.id,
      title: item.title,
      directory: item.directory,
      projectID: item.projectID,
      ...(item.parentID ? { parentID: item.parentID } : {}),
      ...(item.lastTurn ? { lastTurn: item.lastTurn } : {}),
      time: item.time,
    }) as ClaxedoSession)
    .sort((a, b) => cmp(a.id, b.id))
}
