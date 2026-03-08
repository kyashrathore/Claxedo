import { Process } from "./process"

type Fetch = typeof globalThis.fetch

type Input = {
  baseUrl: string
  directory: string
  fetch?: Fetch
}

type Start = {
  interactive?: boolean
  portConflict?: Process.PortConflictStrategy
}

function link(baseUrl: string, directory: string, path: string) {
  const q = `directory=${encodeURIComponent(directory)}`
  return `${baseUrl}/process${path}${path.includes("?") ? "&" : "?"}${q}`
}

function head(directory: string) {
  return {
    "Content-Type": "application/json",
    "x-opencode-directory": directory,
  }
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

function launch(raw: unknown, code: number) {
  const hit = Process.LaunchResult.safeParse(raw)
  if (hit.success) return hit.data

  const proc = Process.ManagedProcess.safeParse(raw)
  if (proc.success) {
    return {
      kind: "started",
      process: proc.data,
    } satisfies Process.LaunchResult
  }

  const clash = Process.PortConflictInfo.safeParse(raw)
  if (clash.success) {
    return {
      kind: "port_conflict",
      conflict: clash.data,
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

  async function req(path: string, init?: RequestInit) {
    const res = await fetch(link(input.baseUrl, input.directory, path), {
      ...init,
      headers: {
        ...head(input.directory),
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    return { res, raw: await body(res) }
  }

  async function start(id: string, opts?: Start): Promise<Process.LaunchResult> {
    try {
      const portConflict = opts?.portConflict
      const body = portConflict ? JSON.stringify({ portConflict }) : undefined
      const { res, raw } = await req(`/${encodeURIComponent(id)}/start`, {
        method: "POST",
        ...(body ? { body } : {}),
      })
      const out = launch(raw, res.status)
      if (out.kind === "port_conflict" && opts?.interactive === false && !portConflict) {
        return start(id, { ...opts, portConflict: "pick-new" })
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
      return launch(raw, res.status)
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
      return Process.ListResponse.parse(raw)
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
