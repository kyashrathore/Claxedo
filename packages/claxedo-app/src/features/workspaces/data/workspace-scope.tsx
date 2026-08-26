import { createContext, createMemo, useContext, type Accessor, type JSX } from "solid-js"
import type { DirectorySessionCacheRefresh } from "../../session/data/sync/directory-session-cache"
import { useDirectorySessionCacheActions } from "@/features/workspaces/app-ports"

export type WorkspaceScope = {
  workspaceId: string
}

export type WorkspaceScopeRegistry = {
  workspaceIds: Accessor<readonly string[]>
  scopeFor: (workspaceId: string) => WorkspaceScope | undefined
  refreshDirectory: DirectorySessionCacheRefresh
}

const WorkspaceScopeContext = createContext<WorkspaceScopeRegistry>()

export function distinctWorkspaceIds(ids: Iterable<string | undefined>) {
  return [...new Set([...ids].filter((id): id is string => !!id?.trim()))]
}

export function createWorkspaceScopes(
  ids: Iterable<string | undefined>,
) {
  return new Map(distinctWorkspaceIds(ids).map((workspaceId) => [workspaceId, { workspaceId }]))
}

export function createWorkspaceScopeCache() {
  const cache = new Map<string, WorkspaceScope>()
  return (ids: Iterable<string | undefined>) =>
    new Map(distinctWorkspaceIds(ids).map((workspaceId) => {
      const scope = cache.get(workspaceId) ?? { workspaceId }
      cache.set(workspaceId, scope)
      return [workspaceId, scope]
    }))
}

export function WorkspaceScopeHost(props: {
  workspaceIds: Accessor<readonly string[]> | readonly string[]
  children: JSX.Element
}) {
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const workspaceIds = workspaceIdAccessor(props.workspaceIds)
  const scopeCache = createWorkspaceScopeCache()
  const scopes = createMemo(() => scopeCache(workspaceIds()))
  const registry: WorkspaceScopeRegistry = {
    workspaceIds: () => [...scopes().keys()],
    scopeFor: (workspaceId) => scopes().get(workspaceId),
    refreshDirectory: (directory, harnessType, options) =>
      directorySessionCacheActions.refresh({
        directory,
        harnessType,
        ...options,
      }),
  }

  return (
    <WorkspaceScopeContext.Provider value={registry}>
      {props.children}
    </WorkspaceScopeContext.Provider>
  )
}

function workspaceIdAccessor(input: Accessor<readonly string[]> | readonly string[]) {
  if (typeof input === "function") return input
  return () => input
}

export function useWorkspaceScope(workspaceId: string) {
  const scope = useWorkspaceScopeOptional(workspaceId)
  if (!scope) throw new Error(`WorkspaceScopeHost has no scope for ${workspaceId}`)
  return scope
}

export function useWorkspaceScopeRegistryOptional() {
  return useContext(WorkspaceScopeContext)
}

export function useWorkspaceScopeOptional(workspaceId: string | undefined) {
  const context = useWorkspaceScopeRegistryOptional()
  if (!context || !workspaceId) return undefined
  return context.scopeFor(workspaceId)
}
