import { createMemo, createResource, createSignal, type Accessor } from "solid-js"
import { useSDK } from "@/features/session/app-ports"
import { getClaxedoServerUrl } from "@/platform/api/api"
import { queryClient } from "@/platform/query/query-client"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { createWorkspaceDiffClient } from "@/platform/runtime/workspace-diff-client"
import { resolveWorkspaceRuntime } from "@/platform/runtime/workspace-runtime-record"
import { workspaceVcsQuery } from "@/platform/runtime/workspace-query"

export function createNewSessionBranchSource(input: {
  enabled: Accessor<boolean>
  directory: Accessor<string>
  touch: VoidFunction
  setWorktree: (value: "main" | "create") => void
}) {
  const sdk = useSDK()
  const platform = usePlatform()
  const directory = createMemo(() => input.enabled() ? input.directory() : undefined)
  const [refs] = createResource(directory, async (value) => {
    const workspace = sdk.workspace(value)
    const serverUrl = getClaxedoServerUrl()
    return await createWorkspaceDiffClient({
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
    }).refs(value).catch(() => ({ branches: [], tags: [], recent: [] }))
  })
  const [vcs] = createResource(directory, async (value) => {
    const workspace = sdk.workspace(value)
    return await queryClient.fetchQuery(workspaceVcsQuery({
      baseUrl: sdk.url,
      directory: value,
      request: platform.fetch,
      workspaceId: workspace?.workspaceId,
      workspace,
      signedControlPlane: !!workspace,
      client: sdk.createClient({ directory: value }),
    })).catch(() => undefined)
  })
  const current = createMemo(() => vcs()?.branch ?? vcs()?.default_branch ?? refs()?.branches[0] ?? "HEAD")
  const branches = createMemo(() => [...new Set([current(), ...(refs()?.branches ?? [])])])
  const [explicit, setExplicit] = createSignal<{ scope: string; value: string }>()
  const selected = createMemo(() => {
    const value = explicit()
    if (value && value.scope === directory()) return value.value
    return current()
  })
  const select = (value: string) => {
    input.touch()
    setExplicit({ scope: directory() ?? input.directory(), value })
    input.setWorktree(value === current() ? "main" : "create")
  }
  return { selected, branches, select }
}
