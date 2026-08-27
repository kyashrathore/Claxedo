import { useQuery } from "@tanstack/solid-query"
import { createMemo, createResource, createSignal, type Accessor } from "solid-js"
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
  // The VCS query owns freshness. Key the refs resource to its settled data
  // generation so a HEAD/refs invalidation starts one matching refs read, and
  // createResource's latest-request semantics discard an older in-flight read.
  const refsSource = createMemo(() => {
    const scope = directory()
    if (!scope || vcs.isFetching || !vcs.data) return
    return { scope, vcsUpdatedAt: vcs.dataUpdatedAt }
  })
  const [snapshot] = createResource(refsSource, async ({ scope }): Promise<LoadedBranchRefs> => ({
    scope,
    refs: await diff(scope).refsRequired(scope),
  }))
  const state = createMemo<NewSessionBranchState>(() => {
    const scope = directory()
    if (!scope) return { status: "disabled" }
    const error = snapshot.error ?? vcs.error
    if (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { status: "error", scope, message }
    }
    if (snapshot.loading || vcs.isFetching || snapshot()?.scope !== scope || !vcs.data) {
      return { status: "loading", scope }
    }
    const data = snapshot()
    return data ? settleNewSessionBranchState({ ...data, vcs: vcs.data }) : { status: "loading", scope }
  })
  return { state, ...createNewSessionBranchSelection({ state, worktree: input.worktree, touch: input.touch, setWorktree: input.setWorktree }) }
}
