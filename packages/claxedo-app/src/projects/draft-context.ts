import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useServer, type Placement, type PlacementId, type ProjectId, type Server } from "@/server"
import { createDraftBranches } from "./draft-branches"
import {
  CREATE_WORKSPACE,
  creatingWorkspace,
  currentWorkspace,
  environmentOptions,
  hostKindOf,
  initialWorkspace,
  MAIN_WORKSPACE,
  rootPlacement,
  workspaceOptions,
  type HostKind,
  type WorkspaceChoice,
} from "./draft-workspaces"

export type DraftTarget = { readonly projectId: ProjectId; readonly placementId: PlacementId }

function createTargetChoice(server: Server, draft: Accessor<DraftTarget>) {
  const placements = () => server.placements.list()
  const placementOf = (id: PlacementId) => placements().find((item) => item.id === id)
  const [hostKind, setHostKind] = createSignal<HostKind>(hostKindOf(placementOf(draft().placementId)))
  const [selected, setSelected] = createSignal<WorkspaceChoice>(initialWorkspace(placements(), draft().placementId))
  const reset = (placementId: PlacementId) => {
    setHostKind(hostKindOf(placementOf(placementId)))
    setSelected(initialWorkspace(placements(), placementId))
  }
  const chooseHostKind = (kind: HostKind) => {
    setHostKind(kind)
    setSelected(MAIN_WORKSPACE)
  }
  const options = createMemo(() =>
    workspaceOptions({ placements: placements(), projectId: draft().projectId, hostKind: hostKind(), thisMachine: server.capabilities()?.thisMachine?.id }),
  )
  return { hostKind, chooseHostKind, selected, setSelected, reset, options }
}

type TargetChoice = ReturnType<typeof createTargetChoice>

function createTargetLocation(draft: Accessor<DraftTarget>, choice: TargetChoice, root: Accessor<Placement | undefined>) {
  const current = () => currentWorkspace(choice.options(), choice.selected())
  const creating = () => creatingWorkspace(choice.options(), choice.selected(), choice.hostKind())
  const placement = () => {
    const workspace = current()
    if (workspace === MAIN_WORKSPACE) return root()?.id ?? draft().placementId
    return workspace && workspace !== CREATE_WORKSPACE ? workspace : draft().placementId
  }
  return { current, creating, placement }
}

function createResolver(server: Server, draft: Accessor<DraftTarget>, choice: TargetChoice, location: ReturnType<typeof createTargetLocation>, base: Accessor<string | undefined>) {
  const create = async (): Promise<PlacementId> => {
    const projectId = draft().projectId
    const branch = base()
    const placement = choice.hostKind() === "provisioner"
      ? await server.cloud.create({ projectId, ...(branch ? { branch } : {}) })
      : await server.placements.createWorktree(projectId, branch ? { baseRef: branch } : {})
    choice.setSelected(placement.id)
    return placement.id
  }
  const resolve = async (): Promise<PlacementId> => {
    return location.creating() ? create() : location.placement()
  }
  return resolve
}

export type DraftContext = ReturnType<typeof createDraftContext>

function resetOnDraftChange(draft: Accessor<DraftTarget>, choice: TargetChoice, resetBranch: () => void) {
  createEffect(
    on(
      () => draft().placementId,
      (placementId) => {
        choice.reset(placementId)
        resetBranch()
      },
      { defer: true },
    ),
  )
}

export function createDraftContext(draft: Accessor<DraftTarget>) {
  const server = useServer()
  const choice = createTargetChoice(server, draft)
  const root = createMemo(() => rootPlacement(server.placements.list(), draft().projectId))
  const location = createTargetLocation(draft, choice, root)
  const branchChoice = createDraftBranches(server, () => location.creating() ? root()?.id ?? draft().placementId : location.placement(), location.creating)
  const resolve = createResolver(server, draft, choice, location, branchChoice.base)
  const environments = createMemo(() =>
    environmentOptions({ localExecution: server.capabilities()?.thisMachine !== undefined, cloud: server.capabilities()?.features.cloud === true }),
  )
  resetOnDraftChange(draft, choice, branchChoice.reset)
  return {
    hostKind: choice.hostKind,
    chooseHostKind: (kind: HostKind) => {
      branchChoice.reset()
      choice.chooseHostKind(kind)
    },
    environments,
    options: choice.options,
    current: location.current,
    creating: location.creating,
    chooseWorkspace: (workspace: WorkspaceChoice) => {
      branchChoice.reset()
      choice.setSelected(workspace)
    },
    branches: branchChoice.branches,
    branch: branchChoice.branch,
    base: branchChoice.base,
    chooseBranch: branchChoice.choose,
    resolve,
  }
}

export type DraftPlacementResolver = {
  readonly attach: (context: DraftContext) => void
  readonly resolve: (draft: DraftTarget) => Promise<PlacementId>
}

export function createDraftPlacementResolver(): DraftPlacementResolver {
  let attached: DraftContext | undefined
  return {
    attach: (context) => {
      attached = context
      onCleanup(() => {
        if (attached === context) attached = undefined
      })
    },
    resolve: (draft) => attached?.resolve() ?? Promise.resolve(draft.placementId),
  }
}
