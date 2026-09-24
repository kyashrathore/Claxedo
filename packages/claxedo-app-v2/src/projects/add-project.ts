import { createMemo, type Accessor } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { machine, unreachable, type Machine } from "@/lib/machine"
import type { PlacementId, ProjectId } from "@/server"
import { appErrorOf, type ProjectsServer } from "./api"
import {
  addProjectInitial,
  addProjectTransition,
  type AddProjectEvent,
  type AddProjectState,
  type PlacementChoice,
  type ProjectDraft,
} from "./model"

export type ProjectCreated = {
  readonly projectId: ProjectId
  readonly placementId?: PlacementId
  readonly harnessId?: string
}

export type CloudPlacer = {
  readonly create: (input: { readonly projectId: ProjectId }) => Promise<{ readonly id: PlacementId }>
}

export type AddProjectFlow = {
  readonly state: Machine<AddProjectState, AddProjectEvent>["state"]
  readonly draft: Store<ProjectDraft>
  readonly setDraft: SetStoreFunction<ProjectDraft>
  readonly canAdvance: Accessor<boolean>
  readonly next: () => Promise<void>
  readonly skipAgent: () => void
  readonly back: () => void
}

async function placeOnMachine(server: ProjectsServer, projectId: ProjectId, machineId: string): Promise<PlacementId | undefined> {
  const placements = await server.queryClient.fetchQuery({ ...server.queries.placements.byProject(projectId), staleTime: 0 })
  return placements.find((placement) => placement.machineId === machineId)?.id
}

async function place(
  server: ProjectsServer,
  cloud: CloudPlacer,
  projectId: ProjectId,
  placement: PlacementChoice | undefined,
): Promise<PlacementId | undefined> {
  if (!placement) return undefined
  if (placement.kind === "cloud") return (await cloud.create({ projectId })).id
  return placeOnMachine(server, projectId, placement.machineId)
}

function advanceable(state: AddProjectState, draft: ProjectDraft): boolean {
  switch (state.kind) {
    case "choosingSource":
      return draft.source !== undefined
    case "choosingAgent":
      return draft.harnessId !== undefined
    case "choosingPlacement":
    case "failed":
      return draft.placement !== undefined
    case "creating":
    case "created":
      return false
    default:
      return unreachable(state)
  }
}

export function createAddProjectFlow(input: {
  readonly server: ProjectsServer
  readonly cloud: CloudPlacer
  readonly onCreated: (created: ProjectCreated) => void
}): AddProjectFlow {
  const flow = machine(addProjectInitial, addProjectTransition)
  const [draft, setDraft] = createStore<ProjectDraft>({ name: "" })
  const canAdvance = createMemo(() => advanceable(flow.state(), draft))

  const create = async () => {
    const source = draft.source
    if (!source) return
    flow.send({ type: "createRequested" })
    try {
      const name = draft.name.trim()
      const project = await input.server.projects.create({ ...(name ? { name } : {}), source })
      const placementId = await place(input.server, input.cloud, project.id, draft.placement)
      flow.send({ type: "projectCreated", projectId: project.id, ...(placementId ? { placementId } : {}) })
      input.onCreated({
        projectId: project.id,
        ...(placementId ? { placementId } : {}),
        ...(draft.harnessId ? { harnessId: draft.harnessId } : {}),
      })
    } catch (cause) {
      flow.send({ type: "createFailed", error: appErrorOf(cause) })
    }
  }

  const next = async () => {
    if (!canAdvance()) return
    const state = flow.state()
    if (state.kind === "choosingSource") flow.send({ type: "sourceChosen" })
    else if (state.kind === "choosingAgent") flow.send({ type: "agentChosen" })
    else await create()
  }

  return {
    state: flow.state,
    draft,
    setDraft,
    canAdvance,
    next,
    skipAgent: () => {
      setDraft("harnessId", undefined)
      flow.send({ type: "agentChosen" })
    },
    back: () => flow.send({ type: "back" }),
  }
}
