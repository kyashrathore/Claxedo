import { createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { PlacementId, Server } from "@/server"

export type BranchState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly current?: string; readonly dirty: boolean; readonly branches: readonly string[] }

function useBranches(server: Server, placement: Accessor<PlacementId>, creating: Accessor<boolean>): Accessor<BranchState> {
  const refs = useQuery(() => ({ ...server.queries.git.refs(placement()), enabled: creating() }))
  const status = useQuery(() => server.queries.git.status(placement()))
  return createMemo((): BranchState => {
    if (status.error || (creating() && refs.error)) return { kind: "failed" }
    if (!status.data || (creating() && !refs.data)) return { kind: "loading" }
    return {
      kind: "ready",
      current: status.data.branch,
      dirty: status.data.staged.length > 0 || status.data.unstaged.length > 0,
      branches: creating() && refs.data ? refs.data.branches : [],
    }
  })
}

export function createDraftBranches(server: Server, placement: Accessor<PlacementId>, creating: Accessor<boolean>) {
  const branches = useBranches(server, placement, creating)
  const [base, setBase] = createSignal<string>()
  const branch = () => {
    const state = branches()
    return state.kind === "ready" ? (creating() ? base() ?? state.current : state.current) : undefined
  }
  const choose = (value: string) => {
    const state = branches()
    if (creating() && state.kind === "ready" && state.branches.includes(value)) setBase(value)
  }
  return { branches, branch, base, choose, reset: () => setBase(undefined) }
}
