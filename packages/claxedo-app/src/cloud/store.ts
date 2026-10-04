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
import { cloudWorkspaceTransition, type CloudWorkspaceEvent } from "./model"

export type CloudWorkspaceRow = CloudWorkspace & { readonly state: CloudWorkspaceStatus }

export type CloudList =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly rows: readonly CloudWorkspaceRow[] }
  | { readonly kind: "failed"; readonly error: AppError }

export type CloudWorkspaces = {
  readonly list: Accessor<CloudList>
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

export function useCloudWorkspaces(projectId: Accessor<ProjectId>, enabled: Accessor<boolean>): CloudWorkspaces {
  const server = useServer()
  const query = useQuery(() => ({ ...server.queries.cloud.list(), enabled: enabled() }))
  const [pending, setPending] = createStore<Record<string, Pending | undefined>>({})
  const statusKind = (id: PlacementId): CloudWorkspaceStatus["kind"] =>
    query.data?.find((workspace) => workspace.id === id)?.status.kind ?? "stopped"

  const command = async (id: PlacementId, event: CloudWorkspaceEvent | undefined, run: () => Promise<void>) => {
    if (event) setPending(id, { event, at: statusKind(id) })
    try {
      await run()
    } catch (cause) {
      setPending(id, { event: { type: "commandFailed", reason: toAppError(cause).message }, at: statusKind(id) })
    }
  }

  const list = createMemo((): CloudList => {
    if (query.data !== undefined) {
      const rows = query.data
        .filter((workspace) => workspace.projectId === projectId())
        .map((workspace) => ({ ...workspace, state: displayedStatus(workspace, pending[workspace.id]) }))
      return { kind: "ready", rows }
    }
    if (query.error) return { kind: "failed", error: query.error }
    return { kind: "loading" }
  })

  return {
    list,
    create: async (input) => {
      const workspace = await server.cloud.create({ projectId: projectId(), ...input })
      await command(workspace.id, { type: "startRequested" }, () => server.cloud.start(workspace.id))
      return workspace
    },
    start: (id) => command(id, { type: "startRequested" }, () => server.cloud.start(id)),
    stop: (id) => command(id, { type: "stopRequested" }, () => server.cloud.stop(id)),
    remove: (id) => command(id, undefined, () => server.cloud.remove(id)),
  }
}
