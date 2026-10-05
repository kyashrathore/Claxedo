import { createMemo, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import {
  toAppError,
  useServer,
  type AppError,
  type CloudProjectCreateInput,
  type CloudWorkspace,
  type CloudWorkspaceStatus,
  type PlacementId,
  type ProjectId,
} from "@/server"
import { cloudWorkspaceTransition, isRunning, type CloudCommand, type CloudCommandFailure, type CloudWorkspaceEvent } from "./model"

export type CloudWorkspaceRow = CloudWorkspace & { readonly state: CloudWorkspaceStatus; readonly commandFailure?: CloudCommandFailure }

export type CloudList =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly rows: readonly CloudWorkspaceRow[] }
  | { readonly kind: "failed"; readonly error: AppError }

export type CloudWorkspaces = {
  readonly list: Accessor<CloudList>
  readonly refresh: () => void
  readonly create: (input: Omit<CloudProjectCreateInput, "projectId">) => Promise<CloudWorkspace>
  readonly start: (id: PlacementId) => Promise<void>
  readonly stop: (id: PlacementId) => Promise<void>
  readonly remove: (id: PlacementId) => Promise<void>
}

type Pending = { readonly event: CloudWorkspaceEvent; readonly at: CloudWorkspaceStatus["kind"] }

function displayedStatus(workspace: CloudWorkspace, pending: Pending | undefined): CloudWorkspaceStatus {
  if (!pending || pending.at !== workspace.status.kind) return workspace.status
  return cloudWorkspaceTransition(workspace.status, pending.event)
}

function useCommandRunner(statusKind: (id: PlacementId) => CloudWorkspaceStatus["kind"]) {
  const [pending, setPending] = createStore<Record<string, Pending | undefined>>({})
  const [failures, setFailures] = createStore<Record<string, CloudCommandFailure | undefined>>({})
  const run = async (id: PlacementId, name: CloudCommand, event: CloudWorkspaceEvent | undefined, task: () => Promise<void>) => {
    setFailures(id, undefined)
    if (event) setPending(id, { event, at: statusKind(id) })
    try {
      await task()
    } catch (cause) {
      setPending(id, undefined)
      setFailures(id, { command: name, reason: toAppError(cause).message })
    }
  }
  const row = (workspace: CloudWorkspace): CloudWorkspaceRow => {
    const failure = failures[workspace.id]
    return { ...workspace, state: displayedStatus(workspace, pending[workspace.id]), ...(failure ? { commandFailure: failure } : {}) }
  }
  return { run, row }
}

function useCloudCommands(enabled: Accessor<boolean>, include: (workspace: CloudWorkspace) => boolean) {
  const server = useServer()
  const query = useQuery(() => ({ ...server.queries.cloud.list(), enabled: enabled() }))
  const commands = useCommandRunner((id) => query.data?.find((workspace) => workspace.id === id)?.status.kind ?? "stopped")
  const list = createMemo((): CloudList => {
    if (query.data !== undefined) return { kind: "ready", rows: query.data.filter(include).map(commands.row) }
    if (query.error) return { kind: "failed", error: query.error }
    return { kind: "loading" }
  })
  return {
    list,
    refresh: () => void query.refetch(),
    start: (id: PlacementId) => commands.run(id, "start", { type: "startRequested" }, () => server.cloud.start(id)),
    stop: (id: PlacementId) => commands.run(id, "stop", { type: "stopRequested" }, () => server.cloud.stop(id)),
    remove: (id: PlacementId) => commands.run(id, "remove", undefined, () => server.cloud.remove(id)),
  }
}

export function useCloudWorkspaces(projectId: Accessor<ProjectId>, enabled: Accessor<boolean>): CloudWorkspaces {
  const server = useServer()
  const commands = useCloudCommands(enabled, (workspace) => workspace.projectId === projectId())
  return {
    ...commands,
    create: async (input) => {
      const workspace = await server.cloud.create({ projectId: projectId(), ...input })
      void commands.start(workspace.id)
      return workspace
    },
  }
}

export function useRunningCloudWorkspaces(enabled: Accessor<boolean>): Omit<CloudWorkspaces, "create"> {
  return useCloudCommands(enabled, (workspace) => isRunning(workspace.status))
}
