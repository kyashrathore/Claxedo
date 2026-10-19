import type { Transport } from "../transport"
import type { StartOptions } from "../workspace-start"

export type StartFollow = { readonly options: StartOptions | undefined; readonly resolve: () => void; readonly reject: (error: unknown) => void }

export function cloudCatalog(workspaceIds: () => readonly string[], reads: string[], status: (id: string) => string = () => "ready", follows: StartFollow[] = []): Transport {
  return {
    serverUrl: "http://127.0.0.1:1",
    loopback: false,
    json: async (path: string) => {
      reads.push(path)
      const rows = Object.fromEntries(workspaceIds().map((id) => [id, {
        id, backing: "cloud-vm", workspace_name: id, directory: `workspace:${id}`, status: status(id), reachable: status(id) === "ready",
        ...(status(id) === "failed" ? { error: "The cloud workspace could not start: the image has no runtime" } : {}),
      }]))
      return { deployment: { serverKind: "daemon", issuesSessions: true }, project: [{ id: "prj", worktree: "prj", workspaces: rows }] }
    },
    onSessionHost: () => () => undefined,
    onRuntimeImage: () => () => undefined,
    followRuntime: (_workspaceId: string, options?: StartOptions) =>
      new Promise<void>((resolve, reject) => follows.push({ options, resolve, reject })),
  } as Pick<Transport, "serverUrl" | "loopback" | "json" | "onSessionHost" | "onRuntimeImage" | "followRuntime"> as Transport
}
