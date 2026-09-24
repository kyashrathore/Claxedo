import { createMemo, type Accessor } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { useCloudPlacer, type CloudPlacer } from "@/cloud"
import { machine, unreachable, type Machine as StateMachine } from "@/lib/machine"
import type { Machine, PlacementId, ProjectId, ProjectSource } from "@/server"
import { appErrorOf, useProjectsServer, type ProjectsServer } from "./api"
import {
  addProjectInitial,
  addProjectTransition,
  recordedProjectId,
  type AddProjectEvent,
  type AddProjectState,
  type PlacementChoice,
  type ProjectDraft,
} from "./model"
import { chosenPlacement, placementOptions, type PlacementOption } from "./placement-options"
import { useMachines } from "./store"

export type ProjectCreated = {
  readonly projectId: ProjectId
  readonly placementId?: PlacementId
  readonly harnessId?: string
}

export type AddProjectFlow = {
  readonly state: Accessor<AddProjectState>
  readonly draft: Store<ProjectDraft>
  readonly setDraft: SetStoreFunction<ProjectDraft>
  readonly placementOptions: Accessor<readonly PlacementOption[]>
  readonly placement: Accessor<PlacementChoice | undefined>
  readonly canAdvance: Accessor<boolean>
  readonly next: () => Promise<void>
  readonly skipAgent: () => void
  readonly back: () => void
}

type Creation = {
  readonly server: ProjectsServer
  readonly cloud: CloudPlacer
  readonly flow: StateMachine<AddProjectState, AddProjectEvent>
  readonly draft: Store<ProjectDraft>
  readonly placement: Accessor<PlacementChoice | undefined>
  readonly onCreated: (created: ProjectCreated) => void
}

async function placeOnMachine(server: ProjectsServer, projectId: ProjectId, machineId: string): Promise<PlacementId | undefined> {
  const placements = await server.queryClient.fetchQuery({ ...server.queries.placements.byProject(projectId), staleTime: 0 })
  return placements.find((placement) => placement.machineId === machineId)?.id
}

async function place(creation: Creation, projectId: ProjectId): Promise<PlacementId | undefined> {
  const placement = creation.placement()
  if (!placement) return undefined
  if (placement.kind === "cloud") return (await creation.cloud.create({ projectId })).id
  return placeOnMachine(creation.server, projectId, placement.machineId)
}

async function recordProject(creation: Creation, source: ProjectSource): Promise<ProjectId> {
  const name = creation.draft.name.trim()
  const project = await creation.server.projects.create({ ...(name ? { name } : {}), source })
  creation.flow.send({ type: "projectRecorded", projectId: project.id })
  return project.id
}

async function createProject(creation: Creation): Promise<void> {
  const source = creation.draft.source
  if (!source) return
  const existing = recordedProjectId(creation.flow.state())
  creation.flow.send({ type: "createRequested" })
  try {
    const projectId = existing ?? (await recordProject(creation, source))
    const placementId = await place(creation, projectId)
    creation.flow.send({ type: "projectCreated", projectId, ...(placementId ? { placementId } : {}) })
    const harnessId = creation.draft.harnessId
    creation.onCreated({ projectId, ...(placementId ? { placementId } : {}), ...(harnessId ? { harnessId } : {}) })
  } catch (cause) {
    creation.flow.send({ type: "createFailed", error: appErrorOf(cause) })
  }
}

function advanceable(state: AddProjectState, draft: ProjectDraft, placement: PlacementChoice | undefined): boolean {
  switch (state.kind) {
    case "choosingSource":
      return draft.source !== undefined
    case "choosingAgent":
      return draft.harnessId !== undefined
    case "choosingPlacement":
    case "failed":
      return placement !== undefined
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
  readonly machines: Accessor<readonly Machine[]>
  readonly onCreated: (created: ProjectCreated) => void
}): AddProjectFlow {
  const flow = machine(addProjectInitial, addProjectTransition)
  const [draft, setDraft] = createStore<ProjectDraft>({ name: "" })
  const options = createMemo(() => placementOptions(input.server.capabilities(), input.machines(), draft.source?.kind === "folder"))
  const placement = createMemo(() => chosenPlacement(options(), draft.placement))
  const canAdvance = createMemo(() => advanceable(flow.state(), draft, placement()))
  const creation: Creation = { server: input.server, cloud: input.cloud, flow, draft, placement, onCreated: input.onCreated }
  const next = async () => {
    if (!canAdvance()) return
    const state = flow.state()
    if (state.kind === "choosingSource") flow.send({ type: "sourceChosen" })
    else if (state.kind === "choosingAgent") flow.send({ type: "agentChosen" })
    else await createProject(creation)
  }
  return {
    state: flow.state,
    draft,
    setDraft,
    placementOptions: options,
    placement,
    canAdvance,
    next,
    skipAgent: () => {
      setDraft("harnessId", undefined)
      flow.send({ type: "agentChosen" })
    },
    back: () => flow.send({ type: "back" }),
  }
}

export function useAddProjectFlow(onCreated: (created: ProjectCreated) => void): AddProjectFlow {
  const machines = useMachines()
  return createAddProjectFlow({
    server: useProjectsServer(),
    cloud: useCloudPlacer(),
    machines: () => {
      const state = machines()
      return state.kind === "ready" ? state.data : []
    },
    onCreated,
  })
}
