import { QueryClient } from "@tanstack/solid-query"
import type { CloudServer, CloudWorkspace } from "@/cloud"
import { uuid } from "@/lib/uuid"
import type { CodeHostConnection, CodeHostRepository, ProjectsServer } from "@/projects"
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
  Machine,
  Placement,
  Project,
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

export function createPlaceholderServer(): ProjectsServer & CloudServer {
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
      statuses: async () => ({ reports: [], unreported: { kind: "idle" } }),
      newMessageId: uuid,
      queue: async () => [],
      controlQueued: rejected,
      controlGoal: rejected,
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
    cloud: { create: rejected, start: rejected, stop: rejected, remove: rejected },
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
      projects: {
        list: () => emptyQuery<readonly Project[]>(["projects"], []),
        byId: (project) => unavailableQuery<Project>(["project", project]),
      },
      machines: { list: () => emptyQuery<readonly Machine[]>(["machines"], []) },
      codeHost: {
        connections: () => emptyQuery<readonly CodeHostConnection[]>(["codeHostConnections"], []),
        repositories: (connection) => emptyQuery<readonly CodeHostRepository[]>(["codeHostRepositories", connection], []),
      },
      cloud: { list: () => emptyQuery<readonly CloudWorkspace[]>(["cloud"], []) },
    },
  }
}
