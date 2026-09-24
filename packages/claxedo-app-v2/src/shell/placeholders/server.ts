import { QueryClient } from "@tanstack/solid-query"
import { machineId } from "@/server"
import type {
  AppError,
  Capabilities,
  DiffFile,
  DiffSummary,
  FetchQuery,
  FileContent,
  FileNode,
  GitBases,
  GitCommit,
  GitRefs,
  GitStatus,
  Placement,
  Server,
} from "@/server"

const unavailable = (): AppError => ({ class: "internal", message: "The server adapter has not landed yet", retryable: false })

const rejected = <T,>(): Promise<T> => Promise.reject(unavailable())

function emptyQuery<T>(key: readonly unknown[], value: T): FetchQuery<T> {
  return { queryKey: ["placeholder", ...key], queryFn: async () => value }
}

function unavailableQuery<T>(key: readonly unknown[]): FetchQuery<T> {
  return { queryKey: ["placeholder", ...key], queryFn: () => rejected<T>() }
}

const capabilities: Capabilities = {
  principal: { kind: "machine", machineId: machineId("placeholder") },
  signedIn: false,
  harnesses: [],
  features: {
    tasks: false,
    documents: false,
    cloud: false,
    remoteAccess: false,
    marketplace: false,
    terminals: false,
    browser: false,
    sharing: false,
    livePlugins: false,
  },
}

export function createPlaceholderServer(): Server {
  return {
    connection: () => ({ kind: "connected" }),
    capabilities: () => capabilities,
    queryClient: new QueryClient(),
    subscribe: () => () => undefined,
    sessions: {
      list: async () => ({ rows: [] }),
      snapshot: rejected,
      older: rejected,
      create: rejected,
      prompt: rejected,
      stop: rejected,
      reply: rejected,
      rename: rejected,
      archive: rejected,
      remove: rejected,
    },
    projects: { create: rejected, update: rejected, remove: rejected },
    placements: { byId: () => undefined, createWorktree: rejected },
    terminals: {
      list: async () => [],
      create: rejected,
      update: rejected,
      remove: rejected,
      presence: rejected,
      agents: async () => [],
      agentStatus: async () => undefined,
      attach: rejected,
    },
    git: { stage: rejected, unstage: rejected, commit: rejected, push: rejected },
    queries: {
      files: {
        tree: (placement, path) => emptyQuery<readonly FileNode[]>(["files", placement, path], []),
        content: (placement, path) => unavailableQuery<FileContent>(["file", placement, path]),
        search: (placement, query) => emptyQuery<readonly string[]>(["fileSearch", placement, query], []),
      },
      git: {
        status: (placement) => unavailableQuery<GitStatus>(["gitStatus", placement]),
        log: (placement, limit) => emptyQuery<readonly GitCommit[]>(["gitLog", placement, limit], []),
        refs: (placement) => unavailableQuery<GitRefs>(["gitRefs", placement]),
        bases: (placement) => unavailableQuery<GitBases>(["gitBases", placement]),
        diff: (placement, scope) => emptyQuery<readonly DiffSummary[]>(["diff", placement, scope], []),
        diffFile: (placement, scope, file) => unavailableQuery<DiffFile>(["diffFile", placement, scope, file]),
      },
      placements: { byProject: (project) => emptyQuery<readonly Placement[]>(["placements", project], []) },
    },
  }
}
