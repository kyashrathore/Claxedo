import { createContext, createEffect, createMemo, onCleanup, useContext, type Accessor, type JSX } from "solid-js"
import type { DirectorySessionCacheRefresh } from "../../session/data/sync/directory-session-cache"
import { useDirectorySessionCacheActions } from "@/features/workspaces/app-ports"
import {
  acquireWorkspaceConnection,
  type AcquireWorkspaceConnectionInput,
} from "./workspace-connection"

export type WorkspaceScope = {
  workspaceId: string
}

export type WorkspaceScopeRegistry = {
  workspaceIds: Accessor<readonly string[]>
  scopeFor: (workspaceId: string) => WorkspaceScope | undefined
  refreshDirectory: DirectorySessionCacheRefresh
  /**
   * Keep the canonical connection lease at workspace scope. Returns false when
   * the workspace is not owned by this host, so a standalone gate can retain
   * its legacy component-scoped fallback.
   */
  retainConnection: (input: AcquireWorkspaceConnectionInput) => boolean
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

type WorkspaceConnectionHandle = ReturnType<typeof acquireWorkspaceConnection>

function sameConnectionInput(
  left: AcquireWorkspaceConnectionInput,
  right: AcquireWorkspaceConnectionInput,
) {
  return left.workspaceId === right.workspaceId &&
    left.kind === right.kind &&
    left.directory === right.directory &&
    left.baseUrl === right.baseUrl &&
    left.request === right.request &&
    left.relayRequest === right.relayRequest &&
    left.events === right.events
}

/**
 * One connection lease per workspace scope, independent of whichever session
 * pane happens to be visible. A later caller can refine the connection input
 * (for example user-hosted -> cloud after inventory hydrates); acquiring the
 * replacement before releasing the old handle keeps the authority alive while
 * it applies that refinement.
 */
export function createWorkspaceConnectionLeaseCache(
  acquire: (input: AcquireWorkspaceConnectionInput) => WorkspaceConnectionHandle = acquireWorkspaceConnection,
) {
  const leases = new Map<string, {
    input: AcquireWorkspaceConnectionInput
    handle: WorkspaceConnectionHandle
  }>()

  return {
    retain(input: AcquireWorkspaceConnectionInput) {
      const previous = leases.get(input.workspaceId)
      if (previous && sameConnectionInput(previous.input, input)) return
      const handle = acquire(input)
      previous?.handle.release()
      leases.set(input.workspaceId, { input, handle })
    },
    releaseMissing(workspaceIds: Iterable<string>) {
      const retained = new Set(workspaceIds)
      for (const [workspaceId, lease] of leases) {
        if (retained.has(workspaceId)) continue
        lease.handle.release()
        leases.delete(workspaceId)
      }
    },
    releaseAll() {
      for (const lease of leases.values()) lease.handle.release()
      leases.clear()
    },
    size() {
      return leases.size
    },
  }
}

export function WorkspaceScopeHost(props: {
  workspaceIds: Accessor<readonly string[]> | readonly string[]
  children: JSX.Element
}) {
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const workspaceIds = workspaceIdAccessor(props.workspaceIds)
  const scopeCache = createWorkspaceScopeCache()
  const scopes = createMemo(() => scopeCache(workspaceIds()))
  const connectionLeases = createWorkspaceConnectionLeaseCache()
  const registry: WorkspaceScopeRegistry = {
    workspaceIds: () => [...scopes().keys()],
    scopeFor: (workspaceId) => scopes().get(workspaceId),
    retainConnection: (input) => {
      // Reading the memo here is intentional: WorkspaceGate calls this inside
      // its effect, so a scope entering/leaving the host re-evaluates ownership.
      if (!scopes().has(input.workspaceId)) return false
      connectionLeases.retain(input)
      return true
    },
    refreshDirectory: (directory, harnessType, options) =>
      directorySessionCacheActions.refresh({
        directory,
        harnessType,
        ...options,
      }),
  }

  createEffect(() => {
    connectionLeases.releaseMissing(scopes().keys())
  })
  onCleanup(() => connectionLeases.releaseAll())

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
