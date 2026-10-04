import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { machineOfPlacement, useServer, type Placement, type PlacementId, type ProjectId, type Server } from "@/server"
import { createDraftBranches } from "./draft-branches"
import { creationOf, currentPlacement, whereEntries, worktreeRoots, type WhereChoice, type WhereNew } from "./draft-where"
import { useProject, type ProjectView } from "./store"

export type DraftTarget = { readonly projectId: ProjectId; readonly placementId: PlacementId }

function clonesFromRepository(view: ProjectView): boolean {
  return view.kind === "ready" && (view.project.source?.kind === "repository" || view.project.source?.kind === "connectedRepository")
}

function createWhere(server: Server, draft: Accessor<DraftTarget>) {
  const machines = useQuery(() => server.queries.machines.list())
  const entries = createMemo(() => whereEntries({ placements: server.placements.list(), projectId: draft().projectId }))
  const [choice, setChoice] = createSignal<WhereChoice>({ kind: "placement", id: draft().placementId })
  const current = createMemo(() => currentPlacement(entries(), choice()))
  const placement = (): PlacementId => {
    const chosen = choice()
    return chosen.kind === "placement" ? chosen.id : draft().placementId
  }
  const machineOf = (target: Placement) => machineOfPlacement(machines.data ?? [], target)
  return {
    entries,
    choice,
    setChoice,
    current,
    placement,
    machineOf,
    machinesLoaded: () => machines.data !== undefined,
    hasMachine: () => machines.data?.some((machine) => machine.enrolled || machine.isThisMachine) === true,
    roots: createMemo(() => worktreeRoots(entries())),
  }
}

type Where = ReturnType<typeof createWhere>

function createResolver(server: Server, where: Where, base: Accessor<string | undefined>) {
  const create = async (choice: WhereNew): Promise<PlacementId> => {
    const branch = base()
    const placement = await server.placements.createWorktree(choice.root, branch ? { baseRef: branch } : {})
    where.setChoice({ kind: "placement", id: placement.id, pendingName: placement.label })
    return placement.id
  }
  return async (onCreate?: (choice: WhereNew) => void): Promise<PlacementId> => {
    const choice = where.choice()
    if (choice.kind === "placement") return choice.id
    onCreate?.(choice)
    return create(choice)
  }
}

export type DraftContext = ReturnType<typeof createDraftContext>

export function createDraftContext(draft: Accessor<DraftTarget>) {
  const server = useServer()
  const project = useProject(() => draft().projectId)
  const where = createWhere(server, draft)
  const creating = () => creationOf(where.choice())
  const branchSource = (): PlacementId => {
    const choice = where.choice()
    return choice.kind === "newWorktree" ? choice.root : where.placement()
  }
  const branchChoice = createDraftBranches(server, branchSource, () => creating() === "worktree")
  const choose = (choice: WhereChoice) => {
    branchChoice.reset()
    where.setChoice(choice)
  }
  createEffect(on(() => draft().placementId, (id) => choose({ kind: "placement", id }), { defer: true }))
  return {
    entries: where.entries,
    choice: where.choice,
    current: where.current,
    creating,
    projectId: () => draft().projectId,
    machineOf: where.machineOf,
    machinesLoaded: where.machinesLoaded,
    hasMachine: where.hasMachine,
    worktreeRoots: where.roots,
    canCreateCloud: () => server.capabilities()?.features.cloud === true && clonesFromRepository(project()),
    choose,
    branches: branchChoice.branches,
    branch: branchChoice.branch,
    base: branchChoice.base,
    chooseBranch: branchChoice.choose,
    resolve: createResolver(server, where, branchChoice.base),
  }
}

export type DraftPlacementResolver = {
  readonly attach: (context: DraftContext) => void
  readonly resolve: (draft: DraftTarget, onCreate?: (choice: WhereNew) => void) => Promise<PlacementId>
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
    resolve: (draft, onCreate) => attached?.resolve(onCreate) ?? Promise.resolve(draft.placementId),
  }
}
