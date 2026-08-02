import type { OpenCodeRequestFn } from "@claxedo/agent-sdk-runtime/adapters"
import { getEffectiveConfig } from "../agent-config"
import { OPENCODE_INTERNAL_BASE, opencodeRequest } from "./engine"

export type McpSyncResult = {
  name: string
  ok: boolean
  status: number
  body?: unknown
  error?: string
}

// Single injected transport now — the synced-status is keyed on one stable
// transport key rather than a per-URL string.
const TRANSPORT_KEY = "opencode-engine"
const synced = new Map<string, Record<string, unknown>>()
let enabled = false

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

async function readResponse(res: Response) {
  const text = await res.text()
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export async function syncMcpConfigToOpencode(
  request: OpenCodeRequestFn,
  config: Record<string, unknown>,
  options: { directory?: string } = {},
): Promise<McpSyncResult[]> {
  const mcp = record(config.mcp)
  const entries = Object.entries(mcp)
  const results: McpSyncResult[] = await Promise.all(entries.map(async ([name, value]) => {
    try {
      const res = await request(new Request(new URL("/mcp", OPENCODE_INTERNAL_BASE), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.directory ? { "x-opencode-directory": options.directory } : {}),
        },
        body: JSON.stringify({ name, config: value }),
        duplex: "half",
      } as RequestInit))
      return {
        name,
        ok: res.ok,
        status: res.status,
        body: await readResponse(res),
        ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
      }
    } catch (err) {
      return {
        name,
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }))
  const status = Object.assign(
    {},
    ...results
      .filter((item) => item.ok)
      .map((item) => record(item.body)),
  )
  if (Object.keys(status).length) synced.set(TRANSPORT_KEY, status)
  return results
}

export function configureOpencodeMcpSync(input: { enabled: boolean }) {
  enabled = input.enabled
}

export async function syncOpencodeMcpConfig(options?: { directory?: string }) {
  if (!enabled) return [] as McpSyncResult[]
  return syncMcpConfigToOpencode(opencodeRequest, await getEffectiveConfig(), options)
}

export function mergeSyncedMcpStatus(current: unknown) {
  return {
    ...synced.get(TRANSPORT_KEY),
    ...record(current),
  }
}
