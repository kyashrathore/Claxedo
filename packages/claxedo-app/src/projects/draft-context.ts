import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type MachineId, type PlacementId, type ProjectId, type Server } from "@/server"
import { createDraftBranches } from "./draft-branches"
import { creationOf, currentPlacement, localRoot, whereEntries, type WhereChoice } from "./draft-where"

export type DraftTarget = { readonly projectId: ProjectId; readonly placementId: PlacementId }

function useMachines(server: Server) {
  const machines = useQuery(() => server.queries.machines.list())
  return {
    connected: () => machines.data?.some((machine) => machine.enrolled),
    name: (id: MachineId) => machines.data?.find((machine) => machine.id === id)?.name,
  }
}

function createWhere(server: Server, draft: Accessor<DraftTarget>) {
  const machines = useMachines(server)
  const entries = createMemo(() =>
    whereEntries({ placements: server.placements.list(), projectId: draft().projectId, thisMachine: server.capabilities()?.thisMachine?.id, machineConnected: machines.connected() }),
  )
  const [choice, setChoice] = createSignal<WhereChoice>({ kind: "placement", id: draft().placementId })
  const current = createMemo(() => currentPlacement(entries(), choice()))
  const creating = () => creationOf(choice())
  const placement = () => current()?.id ?? draft().placementId
  return { entries, choice, setChoice, current, creating, placement, machineName: machines.name, root: createMemo(() => localRoot(entries())) }
}

type Where = ReturnType<typeof createWhere>

function createResolver(server: Server, draft: Accessor<DraftTarget>, where: Where, base: Accessor<string | undefined>) {
  const create = async (choice: WhereChoice): Promise<PlacementId> => {
    const projectId = draft().projectId
    const branch = base()
    const placement = choice.kind === "newCloud"
      ? await server.cloud.create({ projectId, name: choice.name, ...(branch ? { branch } : {}) })
      : await server.placements.createWorktree(projectId, branch ? { baseRef: branch } : {})
    where.setChoice({ kind: "placement", id: placement.id })
    return placement.id
  }
  return async (): Promise<PlacementId> => {
    const choice = where.choice()
    return choice.kind === "placement" ? where.placement() : create(choice)
  }
}

export type DraftContext = ReturnType<typeof createDraftContext>

export function createDraftContext(draft: Accessor<DraftTarget>) {
  const server = useServer()
  const where = createWhere(server, draft)
  const creating = () => where.creating() !== undefined
  const branchChoice = createDraftBranches(server, () => (creating() ? where.root()?.id ?? draft().placementId : where.placement()), creating)
  const choose = (choice: WhereChoice) => {
    branchChoice.reset()
    where.setChoice(choice)
  }
  createEffect(on(() => draft().placementId, (id) => choose({ kind: "placement", id }), { defer: true }))
  return {
    entries: where.entries,
    choice: where.choice,
    current: where.current,
    creating: where.creating,
    machineName: where.machineName,
    canCreateWorktree: () => where.root() !== undefined,
    canCreateCloud: () => server.capabilities()?.features.cloud === true,
    choose,
    branches: branchChoice.branches,
    branch: branchChoice.branch,
    base: branchChoice.base,
    chooseBranch: branchChoice.choose,
    resolve: createResolver(server, draft, where, branchChoice.base),
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
