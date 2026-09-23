import type { Json, ServerRequest } from "@claxedo/plugin-api"
import type { Project, Server } from "@/server"
import type { ServerCalls } from "./server-access"

type ProjectsQueryOptions = { readonly queryKey: readonly unknown[]; readonly queryFn: () => Promise<readonly Project[]> }

type ServerWithCalls = Server & {
  readonly request?: (input: ServerRequest) => Promise<Response>
  readonly operation?: (name: string, input: Json) => Promise<unknown>
  readonly queries?: { readonly projects?: { readonly list: () => ProjectsQueryOptions } }
}

export class AdapterGapError extends Error {
  constructor(member: string) {
    super(`The server adapter does not provide ${member} yet`)
    this.name = "AdapterGapError"
  }
}

export function serverCalls(server: Server): ServerCalls {
  const extended = server as ServerWithCalls
  return {
    request: (input) => {
      if (!extended.request) return Promise.reject(new AdapterGapError("request()"))
      return extended.request(input)
    },
    operation: (name, input) => {
      if (!extended.operation) return Promise.reject(new AdapterGapError("operation()"))
      return extended.operation(name, input)
    },
  }
}

export function projectsQueryOptions(server: Server): (() => ProjectsQueryOptions) | undefined {
  return (server as ServerWithCalls).queries?.projects?.list
}
