/**
 * Talking to the Claxedo control plane.
 *
 * This is the single place an MCP tool reaches the local server. It exists for
 * two reasons that used to be one problem:
 *
 * 1. `documents-tools.ts`, `documents-cli.ts`, `cloud-workspace-tools.ts` and
 *    `process-handler.ts` each declared their own private
 *    `(path, init) => Promise<unknown>` port. Four spellings of one concept —
 *    now one exported `ControlPlaneRequest`.
 *
 * 2. The request function itself lived at module scope in `server.ts`, which
 *    connects a stdio transport as a side effect of being imported, so nothing
 *    could unit test it. Reading `origin`/`token`/defaults as arguments makes
 *    the boundary testable without moving the server's env handling.
 *
 * The JSON reader returns `unknown`, deliberately. The generic form it replaced
 * (`httpRequest<T>`) let each call site name its own return type and receive it
 * unchecked; every caller now narrows the body next to the type it expects.
 */
import { mcpHttpError } from "./http-error"
import { claxedoRequestScope } from "./request-scope"

/**
 * A JSON call to the control plane. `directory` selects the workspace for
 * workspace-scoped clients and is ignored by owner-scoped ones.
 */
export type ControlPlaneRequest = (requestPath: string, init?: RequestInit, directory?: string) => Promise<unknown>

/** The same call returning the response body verbatim (log routes stream text). */
export type ControlPlaneTextRequest = (requestPath: string, init?: RequestInit, directory?: string) => Promise<string>

export type ControlPlaneClient = {
  json: ControlPlaneRequest
  text: ControlPlaneTextRequest
}

export type ControlPlaneConfig = {
  origin: string
  /** Optional bearer token for a signed remote server. */
  token?: string
  /** Directory used when a call passes none. */
  defaultDirectory: string
  /** Workspace id used when the directory is not a `workspace:<id>` reference. */
  defaultWorkspaceId?: string
  /**
   * Owner-scoped calls address the user, not a workspace, so they carry no
   * directory query or `x-claxedo-directory` header.
   */
  scope?: "workspace" | "owner"
  fetch?: typeof globalThis.fetch
}

const workspaceIdFromDirectory = (directory: string) => /^workspace:([^/]+)$/.exec(directory)?.[1]

function parseErrorBody(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return undefined
  }
}

export function createControlPlaneClient(config: ControlPlaneConfig): ControlPlaneClient {
  const doFetch = config.fetch ?? globalThis.fetch
  const owner = config.scope === "owner"

  async function body(requestPath: string, init: RequestInit | undefined, json: boolean, directory?: string) {
    const dir = directory || config.defaultDirectory
    const workspaceId = owner ? "" : workspaceIdFromDirectory(dir) || config.defaultWorkspaceId || ""
    const target = claxedoRequestScope(config.origin, requestPath, owner
      ? { type: "owner" }
      : { type: "workspace", directory: dir, ...(workspaceId ? { workspaceId } : {}) })
    // Built through `Headers`, not object spread, for two reasons. `HeadersInit`
    // also covers `string[][]`, which spreads into an object as numeric indices.
    // And header names are case-insensitive while object keys are not: spreading
    // a caller's `content-type` over our `Content-Type` kept BOTH, and `fetch`
    // then joined them — every documents and cloud-workspace call was sending
    // `Content-Type: application/json, application/json`, and a caller could
    // never have overridden the bearer token. `set` replaces by canonical name.
    const headers = new Headers({
      "Content-Type": "application/json",
      ...target.headers,
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    })
    for (const [name, value] of new Headers(init?.headers)) headers.set(name, value)
    const res = await doFetch(target.url, { ...init, headers })
    const responseText = await res.text()
    if (!res.ok) throw mcpHttpError(res.status, json && responseText.trim() ? parseErrorBody(responseText) : undefined)
    return responseText
  }

  return {
    json: async (requestPath, init, directory) => {
      const responseText = await body(requestPath, init, true, directory)
      if (!responseText.trim()) return null
      const parsed: unknown = JSON.parse(responseText)
      return parsed
    },
    text: (requestPath, init, directory) => body(requestPath, init, false, directory),
  }
}
