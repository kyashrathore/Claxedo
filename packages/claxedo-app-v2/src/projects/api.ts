import { useServer, type AppError, type FetchQuery, type Machine, type Project, type ProjectId, type Server } from "@/server"

export type CodeHostConnection = {
  readonly id: string
  readonly providerName: string
  readonly accountLabel?: string
  readonly status: "connected" | "degraded" | "broken"
}

export type CodeHostRepository = {
  readonly id: string
  readonly fullName: string
  readonly private: boolean
}

export type ProjectsQueries = {
  readonly list: () => FetchQuery<readonly Project[]>
  readonly byId: (id: ProjectId) => FetchQuery<Project>
}

export type MachinesQueries = {
  readonly list: () => FetchQuery<readonly Machine[]>
}

export type CodeHostQueries = {
  readonly connections: () => FetchQuery<readonly CodeHostConnection[]>
  readonly repositories: (connectionId: string) => FetchQuery<readonly CodeHostRepository[]>
}

export type ProjectsServer = Server & {
  readonly queries: {
    readonly projects: ProjectsQueries
    readonly machines: MachinesQueries
    readonly codeHost: CodeHostQueries
  }
}

export function useProjectsServer(): ProjectsServer {
  return useServer() as ProjectsServer
}

export function appErrorOf(cause: unknown): AppError {
  if (typeof cause === "object" && cause !== null && "class" in cause && "retryable" in cause && "message" in cause) {
    return cause as AppError
  }
  return { class: "internal", message: cause instanceof Error ? cause.message : String(cause), retryable: false, cause }
}
