import { createContext, createMemo, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery } from "@tanstack/solid-query"
import type { AppError, PlacementId, ProjectId } from "@/server"
import { failureReason, useCloudServer, type CloudCreateInput, type CloudServer, type CloudServerEvent } from "./api"
import { cloudWorkspaceTransition, type CloudWorkspace, type CloudWorkspaceEvent, type CloudWorkspaceState } from "./model"

export type CloudWorkspaceRow = CloudWorkspace & { readonly state: CloudWorkspaceState }

export type CloudList =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly rows: readonly CloudWorkspaceRow[] }
  | { readonly kind: "failed"; readonly error: AppError }

export type Cloud = {
  readonly workspacesOf: (projectId: Accessor<ProjectId>) => Accessor<CloudList>
  readonly stateOf: (workspace: CloudWorkspace) => CloudWorkspaceState
  readonly create: (input: CloudCreateInput) => Promise<CloudWorkspace>
  readonly start: (id: PlacementId) => Promise<void>
  readonly stop: (id: PlacementId) => Promise<void>
  readonly remove: (id: PlacementId) => Promise<void>
}

function createCloud(server: CloudServer): Cloud {
  const [states, setStates] = createStore<Record<string, CloudWorkspaceState>>({})

  const send = (id: PlacementId, event: CloudWorkspaceEvent, seed: CloudWorkspaceState) => {
    setStates(id, (current) => cloudWorkspaceTransition(current ?? seed, event))
  }
  const seeded = (workspace: CloudWorkspace): CloudWorkspaceState => {
    const current = states[workspace.id]
    if (current) return current
    setStates(workspace.id, workspace.status)
    return workspace.status
  }

  const onEvent = (event: CloudServerEvent) => {
    if (event.type !== "cloudWorkspaceChanged") return
    send(event.workspaceId, { type: "statusReported", status: event.status }, event.status)
  }
  onCleanup(server.subscribe(onEvent))

  const command = async (id: PlacementId, requested: CloudWorkspaceEvent, run: () => Promise<void>) => {
    send(id, requested, { kind: "stopped" })
    try {
      await run()
    } catch (cause) {
      send(id, { type: "commandFailed", reason: failureReason(cause) }, { kind: "stopped" })
      throw cause
    }
  }

  return {
    workspacesOf: (projectId) => {
      const query = useQuery(() => server.queries.cloud.list())
      return createMemo((): CloudList => {
        if (query.data !== undefined) {
          const rows = query.data
            .filter((workspace) => workspace.projectId === projectId())
            .map((workspace) => ({ ...workspace, state: states[workspace.id] ?? seeded(workspace) }))
          return { kind: "ready", rows }
        }
        if (query.error) return { kind: "failed", error: query.error }
        return { kind: "loading" }
      })
    },
    stateOf: (workspace) => states[workspace.id] ?? seeded(workspace),
    create: async (input) => {
      const workspace = await server.cloud.create(input)
      setStates(workspace.id, workspace.status)
      return workspace
    },
    start: (id) => command(id, { type: "startRequested" }, () => server.cloud.start(id)),
    stop: (id) => command(id, { type: "stopRequested" }, () => server.cloud.stop(id)),
    remove: (id) => server.cloud.remove(id),
  }
}

const CloudContext = createContext<Cloud>()

export function CloudProvider(props: ParentProps) {
  const cloud = createCloud(useCloudServer())
  return <CloudContext.Provider value={cloud}>{props.children}</CloudContext.Provider>
}

export function useCloud(): Cloud {
  const cloud = useContext(CloudContext)
  if (!cloud) throw new Error("useCloud needs a CloudProvider above it")
  return cloud
}
