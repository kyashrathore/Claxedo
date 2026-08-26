import type { Process } from "./process"
import { createTransport } from "@/platform/runtime/transport"
import { centralTransportForServer, type WorkspaceRuntimeSnapshotLike } from "@/platform/runtime/transport"
import { memoizeSuccessfulLoad } from "@/lib/retry"

type Fetch = typeof globalThis.fetch

/**
 * Lazy boundary: ./process defines its wire schemas with zod, and this module is
 * on the boot path (feature-ports wires createProcessClient into the session app
 * ports at startup). Only the request methods need the schemas, so zod loads on
 * the first process API call instead of riding the boot chunk. Failed loads are
 * cleared so the next process API call can retry. Guarded by
 * scripts/forbidden-eager-deps.config.ts (zod entry).
 */
const loadProcessSchemas = memoizeSuccessfulLoad(() => import("./process").then((module) => module.Process))

type Input = {
  baseUrl: string
  directory: string
  workspaceId?: string
  workspaceName?: string
  fetch?: Fetch
  resolveWorkspaceRuntime?: (input: {
    directory: string
  }) => Promise<{ kind?: "local" | "cloud" | "user-hosted" | null; workspaceId?: string | null } | null>
}

type Start = {
  interactive?: boolean
  portConflict?: Process.PortConflictStrategy
  routeConflict?: Process.PortConflictStrategy
}

function processPath(input: Pick<Input, "directory" | "workspaceId">, path: string, workspaceId = input.workspaceId) {
  const search = new URLSearchParams()
  search.set("directory", input.directory)
  if (workspaceId) search.set("workspaceId", workspaceId)
  const query = search.toString()
  return `/api/wr/process${path}${query ? `${path.includes("?") ? "&" : "?"}${query}` : ""}`
}

async function body(res: Response) {
  if (typeof res.text !== "function") {
    if (typeof res.json !== "function") return undefined
    return await res.json().catch(() => undefined)
  }
  const text = await res.text()
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function detail(raw: unknown, code: number) {
  if (raw && typeof raw === "object" && "error" in raw && typeof raw.error === "string") {
    return raw.error
  }
  if (typeof raw === "string" && raw) return raw
  return `HTTP ${code}`
}

function launch(schemas: typeof Process, raw: unknown, code: number) {
  const hit = schemas.LaunchResult.safeParse(raw)
  if (hit.success) return hit.data

  const proc = schemas.ManagedProcess.safeParse(raw)
  if (proc.success) {
    return {
      kind: "started",
      process: proc.data,
    } satisfies Process.LaunchResult
  }

  const clash = schemas.PortConflictInfo.safeParse(raw)
  if (clash.success) {
    return {
      kind: "port_conflict",
      conflict: clash.data,
    } satisfies Process.LaunchResult
  }

  const routeClash = schemas.RouteConflictInfo.safeParse(raw)
  if (routeClash.success) {
    return {
      kind: "route_conflict",
      conflict: routeClash.data,
    } satisfies Process.LaunchResult
  }

  if (code === 404) {
    return {
      kind: "not_found",
      error: detail(raw, code),
    } satisfies Process.LaunchResult
  }

  return {
    kind: "failed",
    error: detail(raw, code),
  } satisfies Process.LaunchResult
}

export function createProcessClient(input: Input) {
  const fetch = input.fetch ?? globalThis.fetch.bind(globalThis)
  const transportFor = async () => {
    const workspace =
      workspaceRuntimeSnapshot(input.workspaceId ? { kind: "cloud", workspaceId: input.workspaceId } : undefined) ??
      workspaceRuntimeSnapshot(await input.resolveWorkspaceRuntime?.({ directory: input.directory }))
    const serverTransport = centralTransportForServer(input.baseUrl)
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
      serverUrl: input.baseUrl,
      directory: input.directory,
      request: fetch,
    })
  }

  async function req(path: string, init?: RequestInit) {
    const headers = new Headers(init?.headers)
    headers.set("x-opencode-directory", input.directory)
    if (input.workspaceId) headers.set("x-workspace-id", input.workspaceId)
    if (input.workspaceName) headers.set("x-workspace-name", input.workspaceName)
    if (init?.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    const res = await (await transportFor()).fetch(processPath(input, path), { ...init, headers })
    return { res, raw: await body(res) }
  }

  async function start(id: string, opts?: Start): Promise<Process.LaunchResult> {
    try {
      const portConflict = opts?.portConflict
      const routeConflict = opts?.routeConflict
      const payload: Record<string, Process.PortConflictStrategy> = {}
      if (portConflict) payload.portConflict = portConflict
      if (routeConflict) payload.routeConflict = routeConflict
      const body = Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined
      const { res, raw } = await req(`/${encodeURIComponent(id)}/start`, {
        method: "POST",
        ...(body ? { body } : {}),
      })
      const out = launch(await loadProcessSchemas(), raw, res.status)
      if (out.kind === "port_conflict" && opts?.interactive === false && !portConflict) {
        return start(id, { ...opts, portConflict: "pick-new" })
      }
      if (out.kind === "route_conflict" && opts?.interactive === false && !routeConflict) {
        return start(id, { ...opts, routeConflict: "pick-new" })
      }
      return out
    } catch (err) {
      return {
        kind: "failed",
        error: detail(err instanceof Error ? err.message : err, 0),
      }
    }
  }

  async function restart(id: string): Promise<Process.LaunchResult> {
    try {
      const { res, raw } = await req(`/${encodeURIComponent(id)}/restart`, {
        method: "POST",
      })
      return launch(await loadProcessSchemas(), raw, res.status)
    } catch (err) {
      return {
        kind: "failed",
        error: detail(err instanceof Error ? err.message : err, 0),
      }
    }
  }

  return {
    async list(init?: RequestInit): Promise<Process.ListResponse> {
      const { res, raw } = await req("", { method: "GET", ...init })
      if (!res.ok) throw new Error(detail(raw, res.status))
      return (await loadProcessSchemas()).ListResponse.parse(raw)
    },

    async createConfig(config: unknown): Promise<Process.ProcessConfig> {
      const { res, raw } = await req("", {
        method: "POST",
        body: JSON.stringify(config),
      })
      if (!res.ok) throw new Error(detail(raw, res.status))
      return (await loadProcessSchemas()).ProcessConfig.parse(raw)
    },

    async updateConfig(id: string, config: unknown): Promise<Process.ProcessConfig> {
      const { res, raw } = await req(`/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(config),
      })
      if (!res.ok) throw new Error(detail(raw, res.status))
      return (await loadProcessSchemas()).ProcessConfig.parse(raw)
    },

    async deleteConfig(id: string) {
      const { res, raw } = await req(`/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
      if (!res.ok) throw new Error(detail(raw, res.status))
      return raw === undefined ? true : raw === true
    },

    start,

    restart,

    async stop(id: string) {
      try {
        const { res, raw } = await req(`/${encodeURIComponent(id)}/stop`, {
          method: "POST",
        })
        if (!res.ok) return false
        return raw === undefined ? true : raw === true
      } catch {
        return false
      }
    },

    async startAll() {
      try {
        const { res, raw } = await req("/start-all", {
          method: "POST",
        })
        if (!res.ok) return false
        return raw === undefined ? true : raw === true
      } catch {
        return false
      }
    },

    async stopAll() {
      try {
        const { res, raw } = await req("/stop-all", {
          method: "POST",
        })
        if (!res.ok) return false
        return raw === undefined ? true : raw === true
      } catch {
        return false
      }
    },
  }
}

function workspaceRuntimeSnapshot(input: WorkspaceRuntimeSnapshotLike | undefined) {
  if (input?.kind && input.kind !== "local" && input.workspaceId) {
    return { workspaceId: input.workspaceId }
  }
}
