import { useQuery } from "@tanstack/solid-query"
import { createEffect, createMemo, createResource, createSignal, on, type Accessor } from "solid-js"
import { useSDK } from "@/features/session/app-ports"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { createWorkspaceDiffClient, type VcsRefs } from "@/platform/runtime/workspace-diff-client"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"

export type NewSessionBranchChoice = { gitRef: string; sourceBranch?: string }
export type NewSessionBranchState =
  | { status: "disabled" }
  | { status: "loading"; scope: string }
  | { status: "error"; scope: string; message: string }
  | { status: "ready"; scope: string; current: NewSessionBranchChoice; choices: NewSessionBranchChoice[] }

type VcsInfo = { branch?: string; default_branch?: string }
type LoadedBranchRefs = { scope: string; refs: VcsRefs }
type LoadedBranchData = LoadedBranchRefs & { vcs: VcsInfo }

export function shouldQueueNewSessionBranchRefsRefresh(input: {
  fetching: boolean
  previouslyFetching: boolean | undefined
}) {
  return !input.fetching && input.previouslyFetching === true
}

export function settleNewSessionBranchState(data: LoadedBranchData): NewSessionBranchState {
  const choices = data.refs.branchChoices ?? []
  const currentName = data.vcs.branch ?? data.vcs.default_branch
  if (!currentName) return { status: "error", scope: data.scope, message: "Current branch is unavailable" }
  const current = choices.find((choice) => choice.gitRef === currentName || choice.sourceBranch === currentName)
  if (!current) return { status: "error", scope: data.scope, message: "Current branch is not resolvable" }
  return { status: "ready", scope: data.scope, current, choices }
}

export function createNewSessionBranchSelection(input: {
  state: Accessor<NewSessionBranchState>
  worktree: Accessor<string>
  touch: VoidFunction
  setWorktree: (value: "main" | "create") => void
}) {
  const [explicit, setExplicit] = createSignal<{ scope: string; gitRef: string }>()
  const choices = createMemo(() => {
    const state = input.state()
    return state.status === "ready" ? state.choices : []
  })
  const selected = createMemo(() => {
    const state = input.state()
    if (state.status !== "ready") return
    const value = explicit()
    if (value?.scope !== state.scope) return state.current
    return state.choices.find((choice) => choice.gitRef === value.gitRef) ?? state.current
  })
  const select = (gitRef: string) => {
    const state = input.state()
    if (state.status !== "ready") return
    const choice = state.choices.find((item) => item.gitRef === gitRef)
    if (!choice) return
    input.touch()
    if (choice.gitRef === state.current.gitRef) {
      setExplicit()
      if (input.worktree() !== "create") input.setWorktree("main")
      return
    }
    setExplicit({ scope: state.scope, gitRef })
    input.setWorktree("create")
  }
  const syncWorktree = (value: string) => {
    if (value === "create") return
    setExplicit()
  }
  return { choices, selected, select, syncWorktree }
}

export function createNewSessionBranchSource(input: {
  enabled: Accessor<boolean>
  directory: Accessor<string>
  worktree: Accessor<string>
  touch: VoidFunction
  setWorktree: (value: "main" | "create") => void
}) {
  const sdk = useSDK()
  const platform = usePlatform()
  const directory = createMemo(() => input.enabled() ? input.directory() : undefined)
  const diff = (value: string) => {
    const workspace = sdk.workspace(value)
    const serverUrl = getClaxedoServerUrl()
    return createWorkspaceDiffClient({
      serverUrl,
      directory: value,
      request: platform.fetch,
      workspaceId: workspace?.workspaceId,
      workspace,
      resolveWorkspaceRuntime: (runtime) => resolveWorkspaceRuntime({
        baseUrl: serverUrl,
        request: platform.fetch,
        directory: runtime.directory,
      }),
    })
  }
  const [snapshot, { refetch }] = createResource(directory, async (value): Promise<LoadedBranchRefs> => ({
    scope: value,
    refs: await diff(value).refsRequired(value),
  }))
  const vcs = useQuery(() => {
    const value = directory() ?? ""
    const workspace = value ? sdk.workspace(value) : undefined
    return {
      ...workspaceVcsQuery({
        baseUrl: sdk.url,
        directory: value,
        request: platform.fetch,
        workspaceId: workspace?.workspaceId,
        workspace,
        signedControlPlane: !!workspace,
        client: sdk.createClient({ directory: value }),
      }),
      enabled: !!value,
    }
  })
  // VCS freshness is event-owned. Its query is invalidated for HEAD and refs
  // changes. Queue a refs read after each VCS reconciliation and keep that queue
  // through an already-running refs request, so values from different event
  // generations are never combined into one ready snapshot.
  const [refsRefreshPending, setRefsRefreshPending] = createSignal(false)
  createEffect(on(() => vcs.isFetching, (fetching, previous) => {
    if (!shouldQueueNewSessionBranchRefsRefresh({
      fetching,
      previouslyFetching: previous,
    })) return
    setRefsRefreshPending(true)
  }))
  createEffect(() => {
    if (!directory() || !refsRefreshPending() || snapshot.loading) return
    setRefsRefreshPending(false)
    void refetch()
  })
  const state = createMemo<NewSessionBranchState>(() => {
    const scope = directory()
    if (!scope) return { status: "disabled" }
    const error = snapshot.error ?? vcs.error
    if (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: "error", scope, message }
    }
    if (snapshot.loading || refsRefreshPending() || vcs.isFetching || snapshot()?.scope !== scope || !vcs.data) {
      return { status: "loading", scope }
    }
    const data = snapshot()
    return data ? settleNewSessionBranchState({ ...data, vcs: vcs.data }) : { status: "loading", scope }
  })
  return { state, ...createNewSessionBranchSelection({ state, worktree: input.worktree, touch: input.touch, setWorktree: input.setWorktree }) }
}
