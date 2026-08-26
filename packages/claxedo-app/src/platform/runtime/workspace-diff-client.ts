import { createTransport } from "@/platform/runtime/transport"
import {
  centralTransportForServer,
  type WorkspaceRuntimeRequestOptions,
  type WorkspaceRuntimeSnapshotLike,
} from "@/platform/runtime/transport"

type RawVcsFileDiff = {
  file: string
  before?: string
  after?: string
  patch?: string
  additions: number
  deletions: number
  status?: string
}

export type VcsRefs = {
  branches: string[]
  tags: string[]
  recent: { hash: string; subject: string }[]
}

export type WorkspaceDiffClient = ReturnType<typeof createWorkspaceDiffClient>

type WorkspaceDiffResource = "vcs" | "vcs/file" | "refs" | "targets"

async function json<T>(res: Response, fallback: T) {
  if (!res.ok) return fallback
  return (await res.json().catch(() => fallback)) as T
}

export function createWorkspaceDiffClient(options: WorkspaceRuntimeRequestOptions) {
  const transportFor = async (dir: string) => {
    const workspace =
      workspaceRuntimeSnapshot(options.workspace) ??
      workspaceRuntimeSnapshot(options.workspaceId ? { kind: "cloud", workspaceId: options.workspaceId } : undefined) ??
      workspaceRuntimeSnapshot(
        await options.resolveWorkspaceRuntime?.({
          directory: dir,
          workspaceId: options.workspaceId,
        }),
      )
    const serverTransport = centralTransportForServer(options.serverUrl)
    return createTransport({
      placement: workspace
        ? {
            workspaceId: workspace.workspaceId,
            hosting: "workspace",
            transport: serverTransport === "loopback" ? "loopback" : "workspace-relay",
          }
        : {
            hosting: "workspace",
            transport: serverTransport,
          },
      serverUrl: options.serverUrl,
      directory: dir,
      request: options.request,
      relayRequest: options.relayRequest,
    })
  }

  const fetch = async (dir: string, path: string) => (await transportFor(dir)).fetch(path)

  return {
    async vcs(input: {
      directory: string
      mode: string
      fromRef?: string
      toRef?: string
      content?: "full" | "summary"
    }) {
      const res = await fetch(
        input.directory,
        workspaceDiffPath({
          resource: "vcs",
          query: input,
        }),
      )
      const data = await json<unknown[]>(res, [])
      return Array.isArray(data) ? (data as RawVcsFileDiff[]) : []
    },

    async vcsFile(input: { directory: string; mode: string; file: string; fromRef?: string; toRef?: string }) {
      const res = await fetch(
        input.directory,
        workspaceDiffPath({
          resource: "vcs/file",
          query: input,
        }),
      )
      return await json<(Partial<RawVcsFileDiff> & { file: string }) | undefined>(res, undefined)
    },

    async refs(directory: string) {
      const res = await fetch(
        directory,
        workspaceDiffPath({
          resource: "refs",
          query: { directory },
        }),
      )
      return await json<VcsRefs>(res, { branches: [], tags: [], recent: [] })
    },

    async targets(directory: string) {
      const res = await fetch(
        directory,
        workspaceDiffPath({
          resource: "targets",
          query: { directory },
        }),
      )
      return await json<{ defaultRef?: string; candidates?: string[] }>(res, {})
    },
  }
}

function workspaceRuntimeSnapshot(input: WorkspaceRuntimeSnapshotLike | undefined) {
  if (input?.kind && input.kind !== "local" && input.workspaceId) {
    return { workspaceId: input.workspaceId }
  }
}

function workspaceDiffPath(input: { resource: WorkspaceDiffResource; query?: Record<string, string | undefined> }) {
  const url = new URL(`/api/wr/diff/${input.resource}`, "http://claxedo.local")
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return `${url.pathname}${url.search}`
}
