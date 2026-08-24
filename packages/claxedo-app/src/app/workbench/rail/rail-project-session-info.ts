import { createMemo, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { getFilename } from "@/lib/path"
import {
  projectWorkspaceDirectories,
  workspaceDisplayName,
  workspaceIsCloud,
} from "../../../features/workspaces/lib/workspace-display"
import {
  directorySessionCacheQueryOptions,
  emptySessionInventory,
  sessionInventoryQueryOptions,
  type DirectorySessionCacheValue,
} from "../../../features/session/data/sync/queries"
import { queryClient } from "@/platform/query/query-client"
import type { SessionInventoryRow } from "../../../features/session/data/query/types"
import type { ProjectItem, WorkspaceItem } from "./domain-types"
import { parseOwnerRepo } from "./rail-git-remote"

type SessionGitMetadata = {
  git?: {
    repo?: string
    remote?: string
    branch?: string
  }
}

export type RailSessionGitSource = SessionGitMetadata & {
  id?: string
  directory?: string
  workspaceId?: string
  projectID?: string
  time?: { created?: number; updated?: number }
}

export type RailSessionInventory = {
  sessions: RailSessionGitSource[]
  byProject: Record<string, RailSessionGitSource[]>
  byWorkspace: Record<string, { sessions: RailSessionGitSource[] }>
}

export type RailWorktreeInfo = {
  name: string
  projectName: string
  projectWorktree: string
  gitRepo?: string
  gitBranch?: string
  gitRemote?: string
  isMain: boolean
  tooltip: string
}

export function railProjectDisplayName(project: ProjectItem, repoName?: string): string {
  return repoName ?? project.name ?? getFilename(project.worktree)
}

export function useRailProjectSessionInfo(input: {
  baseUrl: Accessor<string>
  mainIsCloud: Accessor<boolean>
  projects: Accessor<ProjectItem[]>
}) {
  const sessionInventoryQuery = useQuery(() =>
    sessionInventoryQueryOptions<SessionInventoryRow>({
      baseUrl: input.baseUrl(),
    }),
  )
  return createRailProjectSessionLookups({
    mainIsCloud: input.mainIsCloud,
    projects: input.projects,
    sessionInventory: createMemo(() => sessionInventoryQuery.data ?? emptySessionInventory<SessionInventoryRow>()),
  })
}

export function createRailProjectSessionLookups(input: {
  mainIsCloud: Accessor<boolean>
  projects: Accessor<ProjectItem[]>
  sessionInventory: Accessor<RailSessionInventory>
}) {
  const lookup = createMemo(() => {
    const inventory = input.sessionInventory()
    const projects = input.projects()
    const mainIsCloud = input.mainIsCloud()
    const repoNames = new Map<string, string | undefined>()
    const captions = new Map<string, string>()
    const worktrees = new Map<string, RailWorktreeInfo>()

    for (const project of projects) {
      repoNames.set(railProjectLookupKey(project), railProjectRepoName({ project, inventory }))
    }

    for (const project of projects) {
      const key = railProjectLookupKey(project)
      captions.set(key, railProjectCaptionFromRepo(project, repoNames.get(key)))
      for (const workspace of railProjectWorkspaces(project, mainIsCloud)) {
        const info = railWorktreeInfo({
          dir: workspace.id,
          projects,
          inventory,
          isCloud: mainIsCloud,
        })
        if (!info) continue
        worktrees.set(workspace.id, info)
        worktrees.set(workspace.directory, info)
      }
    }

    return { captions, repoNames, worktrees }
  })
  const projectRepoName = (project: ProjectItem) => {
    const key = railProjectLookupKey(project)
    const current = lookup().repoNames
    if (current.has(key)) return current.get(key)
    return railProjectRepoName({ project, inventory: input.sessionInventory() })
  }
  const projectCaption = (project: ProjectItem) => {
    const key = railProjectLookupKey(project)
    return lookup().captions.get(key) ?? railProjectCaption({ project, inventory: input.sessionInventory() })
  }
  const worktreeInfo = (workspaceDir: string) =>
    lookup().worktrees.get(workspaceDir) ??
    railWorktreeInfo({
      dir: workspaceDir,
      projects: input.projects(),
      inventory: input.sessionInventory(),
      isCloud: input.mainIsCloud(),
    })
  return {
    projectCaption,
    projectRepoName,
    sessionInventory: input.sessionInventory,
    worktreeInfo,
  }
}

export function railProjectHasDir(project: ProjectItem, dir: string) {
  return dir === project.worktree || (project.sandboxes ?? []).includes(dir) || dir in (project.workspaces ?? {})
}

export function railProjectMatchesRef(project: ProjectItem, ref?: string) {
  if (!ref) return false
  return ref === project.id || ref === project.worktree
}

export function railProjectWorkspaces(project: ProjectItem, mainIsCloud: boolean): WorkspaceItem[] {
  return projectWorkspaceDirectories(project).map((workspacePath) => {
    const info = project.workspaces?.[workspacePath]
    const main = workspacePath === project.worktree
    const cloud = workspaceIsCloud(project, workspacePath, { mainIsCloud })
    return {
      id: workspacePath,
      workspaceId: cloud ? (info?.workspaceId ?? info?.id ?? workspacePath) : undefined,
      workspaceName: info?.workspace_name ?? undefined,
      directory: info?.directory ?? workspacePath,
      name: workspaceDisplayName(project, workspacePath, { cloud }),
      isMain: main,
      projectWorktree: project.worktree,
      isCloud: cloud,
      canDelete: main ? cloud : true,
      available: info?.available ?? true,
    }
  })
}

export function railProjectGitSessions(input: { project: ProjectItem; inventory: RailSessionInventory }) {
  const keys = new Set([
    input.project.id,
    input.project.worktree,
    ...projectWorkspaceDirectories(input.project),
    ...Object.entries(input.project.workspaces ?? {}).flatMap(([key, workspace]) =>
      [key, workspace.id, workspace.workspaceId, workspace.directory].filter((item): item is string => !!item),
    ),
  ])
  const source: RailSessionGitSource[] = [
    ...input.inventory.sessions,
    ...(input.inventory.byProject[input.project.id] ?? []),
    ...Object.values(input.inventory.byProject).flat(),
    ...Object.values(input.inventory.byWorkspace).flatMap((group) => group.sessions),
    ...cachedProjectSessions(input.project),
  ]
  const seen = new Set<string>()
  return source
    .filter(
      (session) =>
        keys.has(session.projectID ?? "") || keys.has(session.directory ?? "") || keys.has(session.workspaceId ?? ""),
    )
    .filter((session) => {
      const key = session.id ?? `${session.directory ?? ""}:${session.workspaceId ?? ""}:${sessionUpdatedAt(session)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
}

export function railProjectRepoName(input: { project: ProjectItem; inventory: RailSessionInventory }) {
  const remote = railProjectGitSessions(input)
    .map((session) => session.git?.remote)
    .find((item) => !!item)
  return parseOwnerRepo(remote)
}

export function railProjectCaption(input: { project: ProjectItem; inventory: RailSessionInventory }) {
  return railProjectCaptionFromRepo(input.project, railProjectRepoName(input))
}

function railProjectLookupKey(project: ProjectItem) {
  return `${project.id}\0${project.worktree}`
}

function railProjectCaptionFromRepo(project: ProjectItem, repoName?: string) {
  const repo = repoName ?? project.name
  const folder = getFilename(project.worktree)
  if (!repo) return folder
  if (repo === folder) return repo
  return `${repo} · ${folder}`
}

export function railWorktreeInfo(input: {
  dir: string
  projects: ProjectItem[]
  inventory: RailSessionInventory
  isCloud: boolean
}): RailWorktreeInfo | undefined {
  const project = input.projects.find((item) => railProjectHasDir(item, input.dir))
  if (!project) return
  const workspace = railProjectWorkspaces(project, input.isCloud).find(
    (item) => item.id === input.dir || item.directory === input.dir,
  )
  const name = workspace?.name || getFilename(input.dir)
  const cachedSessions = cachedDirectorySessions(input.dir)
  const inventorySessions = railProjectGitSessions({ project, inventory: input.inventory })
  const sessions: RailSessionGitSource[] = [
    ...cachedSessions,
    ...inventorySessions.filter((session) => session.directory === input.dir || session.workspaceId === input.dir),
    ...inventorySessions,
    ...cachedProjectSessions(project),
  ]
  const git = sessions.map((session) => session.git).find((item) => item?.repo || item?.remote || item?.branch)
  const repo = git?.repo ?? parseOwnerRepo(git?.remote) ?? railProjectRepoName({ project, inventory: input.inventory })
  return {
    name,
    projectName: railProjectDisplayName(project, railProjectRepoName({ project, inventory: input.inventory })),
    projectWorktree: project.worktree,
    gitRepo: repo,
    gitBranch: git?.branch,
    gitRemote: git?.remote,
    isMain: !!workspace?.isMain,
    tooltip: `🌳 ${name}`,
  }
}

function cachedDirectorySessions(directory: string) {
  return (
    queryClient.getQueryData<DirectorySessionCacheValue>(directorySessionCacheQueryOptions({ directory }).queryKey)
      ?.session ?? []
  )
}

function cachedProjectSessions(project: ProjectItem) {
  return projectWorkspaceDirectories(project).flatMap(cachedDirectorySessions)
}

function sessionUpdatedAt(session: RailSessionGitSource) {
  return session.time?.updated ?? session.time?.created ?? 0
}
