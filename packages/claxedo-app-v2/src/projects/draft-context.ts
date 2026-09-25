import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type Placement, type PlacementId, type ProjectId, type Server } from "@/server"
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

export type BranchState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly current: string; readonly branches: readonly string[] }

function useBranches(server: Server, placement: Accessor<PlacementId>): Accessor<BranchState> {
  const refs = useQuery(() => server.queries.git.refs(placement()))
  const status = useQuery(() => server.queries.git.status(placement()))
  return createMemo((): BranchState => {
    if (refs.error || status.error) return { kind: "failed" }
    if (!refs.data || !status.data) return { kind: "loading" }
    const current = status.data.branch
    return current ? { kind: "ready", current, branches: refs.data.branches } : { kind: "failed" }
  })
}

function createBranchChoice(branches: Accessor<BranchState>, selected: Accessor<WorkspaceChoice>, select: (choice: WorkspaceChoice) => void) {
  const [explicit, setExplicit] = createSignal<string>()
  const branch = () => {
    const state = branches()
    return state.kind === "ready" ? (explicit() ?? state.current) : undefined
  }
  const choose = (value: string) => {
    const state = branches()
    if (state.kind !== "ready") return
    if (value === state.current) {
      setExplicit(undefined)
      if (selected() !== CREATE_WORKSPACE) select(MAIN_WORKSPACE)
      return
    }
    setExplicit(value)
    select(CREATE_WORKSPACE)
  }
  return { branch, base: explicit, choose, reset: () => setExplicit(undefined) }
}

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

function createResolver(server: Server, draft: Accessor<DraftTarget>, choice: TargetChoice, root: Accessor<Placement | undefined>, base: Accessor<string | undefined>) {
  const current = () => currentWorkspace(choice.options(), choice.selected())
  const creating = () => creatingWorkspace(choice.options(), choice.selected(), choice.hostKind())
  const create = async (): Promise<PlacementId> => {
    const projectId = draft().projectId
    const branch = base()
    if (choice.hostKind() === "provisioner") return (await server.cloud.create({ projectId, ...(branch ? { branch } : {}) })).id
    return (await server.placements.createWorktree(projectId, {})).id
  }
  const resolve = async (): Promise<PlacementId> => {
    if (creating()) return create()
    const workspace = current()
    if (workspace === MAIN_WORKSPACE) return root()?.id ?? draft().placementId
    return workspace && workspace !== CREATE_WORKSPACE ? workspace : draft().placementId
  }
  return { current, creating, resolve }
}

export type DraftContext = ReturnType<typeof createDraftContext>

export function createDraftContext(draft: Accessor<DraftTarget>) {
  const server = useServer()
  const choice = createTargetChoice(server, draft)
  const root = createMemo(() => rootPlacement(server.placements.list(), draft().projectId))
  const branches = useBranches(server, () => root()?.id ?? draft().placementId)
  const branchChoice = createBranchChoice(branches, choice.selected, choice.setSelected)
  const resolver = createResolver(server, draft, choice, root, branchChoice.base)
  const environments = createMemo(() =>
    environmentOptions({ localExecution: server.capabilities()?.thisMachine !== undefined, cloud: server.capabilities()?.features.cloud === true }),
  )
  createEffect(
    on(
      () => draft().placementId,
      (placementId) => {
        choice.reset(placementId)
        branchChoice.reset()
      },
      { defer: true },
    ),
  )
  return {
    hostKind: choice.hostKind,
    chooseHostKind: choice.chooseHostKind,
    environments,
    options: choice.options,
    current: resolver.current,
    creating: resolver.creating,
    chooseWorkspace: choice.setSelected,
    branches,
    branch: branchChoice.branch,
    base: branchChoice.base,
    chooseBranch: branchChoice.choose,
    resolve: resolver.resolve,
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
