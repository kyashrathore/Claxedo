import { createSignal } from "solid-js"
import { isAcpConnectionHarnessId, type AcpConnectionHarnessId } from "@/platform/identity/session-ref"

/**
 * Operator-configured ACP connections, as the server's sanitized discovery
 * projection serves them: identity, label, and enabled state — never commands
 * or environment. The app's ACP picker group is exactly the enabled rows.
 */
export type AcpConnectionRow = {
  key: AcpConnectionHarnessId
  id: string
  label: string
  enabled: boolean
}

/**
 * Defensive wire decoder. Rows are projected to EXACTLY the sanitized fields;
 * anything with a malformed key, a wrong access, or non-string identity/label
 * is dropped, and unexpected fields never survive into app state.
 */
export function decodeAcpConnectionRows(value: unknown): AcpConnectionRow[] {
  const rows = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { connections?: unknown }).connections
    : undefined
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return []
    const item = row as Record<string, unknown>
    if (!isAcpConnectionHarnessId(item.key)) return []
    if (typeof item.id !== "string" || typeof item.label !== "string" || !item.label.trim()) return []
    if (item.access !== "acp") return []
    if (item.key !== `acp:${item.id}`) return []
    return [{
      key: item.key,
      id: item.id,
      label: item.label,
      enabled: item.enabled !== false,
    }]
  })
}

export type AcpConnectionsCatalog = {
  rows: () => AcpConnectionRow[]
  enabled: () => AcpConnectionRow[]
  label: (key: string) => string | undefined
  refresh: () => Promise<void>
}

/**
 * The discovery catalog: fetched from the server's sanitized ACP-connection
 * rows, shared by whoever owns the harness-config store (one catalog per app
 * shell). A fetch failure or a deployment that refuses the local-config
 * surface reads as "no operator connections" — the ACP picker group is simply
 * absent.
 */
export function createAcpConnectionsCatalog(input: {
  base: string
  request: typeof fetch
}): AcpConnectionsCatalog {
  const [rows, setRows] = createSignal<AcpConnectionRow[]>([])
  let loadedOnce = false
  let inflight: Promise<void> | undefined

  const fetchRows = async (): Promise<AcpConnectionRow[]> => {
    try {
      const res = await input.request(
        new URL("/api/claxedo/agent-config/harness/acp-connections", input.base).toString(),
      )
      if (!res.ok) return []
      return decodeAcpConnectionRows(await res.json().catch(() => undefined))
    } catch {
      return []
    }
  }

  const refresh = () => {
    inflight ??= fetchRows()
      .then((next) => {
        setRows(next)
        loadedOnce = true
      })
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  return {
    rows: () => {
      if (!loadedOnce && !inflight) void refresh()
      return rows()
    },
    enabled: () => {
      if (!loadedOnce && !inflight) void refresh()
      return rows().filter((row) => row.enabled)
    },
    label: (key: string) => rows().find((row) => row.key === key)?.label,
    refresh,
  }
}
