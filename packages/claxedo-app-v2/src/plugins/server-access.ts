import {
  operationAllowed,
  routeAllowed,
  type Json,
  type OperationResult,
  type PluginManifest,
  type PluginServer,
  type ServerRequest,
} from "@claxedo/plugin-api"
import type { AppError } from "@/server"

export type ServerCalls = {
  readonly request: (input: ServerRequest) => Promise<Response>
  readonly operation: (name: string, input: Json) => Promise<unknown>
}

export class PluginAccessError extends Error {
  constructor(
    readonly pluginId: string,
    readonly target: string,
  ) {
    super(`${pluginId} may not call ${target}: its manifest does not name it`)
    this.name = "PluginAccessError"
  }
}

function isAppError(error: unknown): error is AppError {
  return typeof error === "object" && error !== null && "class" in error && "retryable" in error
}

async function resultOf(response: Response): Promise<OperationResult> {
  const text = await response.text()
  return { ok: response.ok, status: response.status, body: text === "" ? null : parseBody(text) }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    return { text, parseError: error instanceof Error ? error.message : String(error) }
  }
}

export function createPluginServer(manifest: PluginManifest, calls: ServerCalls): PluginServer {
  const guardRoute = (path: string) => {
    if (!routeAllowed(manifest, path)) throw new PluginAccessError(manifest.id, path)
  }
  return {
    request: async (input) => {
      guardRoute(input.path)
      return calls.request(input)
    },
    operation: async (name, input, daemon) => {
      if (!operationAllowed(manifest, name)) throw new PluginAccessError(manifest.id, name)
      guardRoute(daemon.path)
      try {
        return { ok: true, status: 200, body: await calls.operation(name, input) }
      } catch (error) {
        if (isAppError(error) && error.class === "auth") return resultOf(await calls.request(daemon))
        if (isAppError(error) && error.status !== undefined) return { ok: false, status: error.status, body: error.cause ?? error.message }
        throw error
      }
    },
  }
}
