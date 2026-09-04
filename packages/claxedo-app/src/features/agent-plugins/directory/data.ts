import type { AgentPluginHarness, AgentPluginSourceKind } from "../api"

/**
 * The reads the Directory needs beyond the catalog itself: the sources a
 * catalog is assembled from, and what the harnesses on this machine installed
 * on their own.
 *
 * `machineInstalled` is a LOCAL-rail read: only the machine's own sidecar can
 * see `~/.claude`, `~/.cursor` and `$CODEX_HOME`. Composition passes a signed
 * `sources` half and a local `machineInstalled` half; nothing here decides
 * that, so the account-backed desktop implementation (WP6) can replace the
 * signed half alone.
 */
export type DirectoryApi = {
  sources: DirectorySourcesApi
  machineInstalled(): Promise<MachineInstalled>
}

export type DirectorySourcesApi = {
  list(): Promise<{ sources: DirectorySource[] }>
  add(input: DirectorySourceRegistration): Promise<{ source: DirectorySource }>
  remove(id: string): Promise<void>
}

export type DirectorySourceRegistration = {
  owner: string
  repository: string
  ref?: string
  authority?: "user" | "organization"
}

/** One row of `GET /api/claxedo/plugins/sources`. */
export type DirectorySource = {
  id: string
  kind: AgentPluginSourceKind
  label: string
  repository: string
  ref: string
  authority?: "user" | "organization"
  canRemove: boolean
}

/** A catalog error the source probe produced, shown inline on the add form. */
export type DirectorySourceDiagnostic = {
  sourceId: string
  relativePath: string
  code: string
  message: string
}

export type MachineInstalledEntry = {
  name: string
  version?: string
  root: string
  marketplace?: string
  /** True for entries the Claxedo adapters wrote; the Directory hides those. */
  ownedByClaxedo: boolean
}

export type MachineInstalledHarness = {
  harnessId: Extract<AgentPluginHarness, "claude" | "cursor" | "codex">
  entries: MachineInstalledEntry[]
}

export type MachineInstalled = { harnesses: MachineInstalledHarness[] }

/**
 * A failed source registration, carrying the probe diagnostics the 422 body
 * holds so the add form can name the files that failed to validate.
 */
export class DirectorySourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly diagnostics: DirectorySourceDiagnostic[] = [],
  ) {
    super(message)
    this.name = "DirectorySourceError"
  }
}

type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sourceKind(value: unknown): value is AgentPluginSourceKind {
  return value === "claxedo" || value === "personal" || value === "organization"
}

function directorySource(value: unknown): DirectorySource | undefined {
  if (!record(value)
    || typeof value.id !== "string"
    || !sourceKind(value.kind)
    || typeof value.label !== "string"
    || typeof value.repository !== "string"
    || typeof value.ref !== "string"
    || typeof value.canRemove !== "boolean") return undefined
  const authority = value.authority === "user" || value.authority === "organization" ? value.authority : undefined
  return {
    id: value.id,
    kind: value.kind,
    label: value.label,
    repository: value.repository,
    ref: value.ref,
    ...(authority ? { authority } : {}),
    canRemove: value.canRemove,
  }
}

function diagnostics(value: unknown): DirectorySourceDiagnostic[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => record(item)
    && typeof item.sourceId === "string"
    && typeof item.relativePath === "string"
    && typeof item.code === "string"
    && typeof item.message === "string"
    ? [{ sourceId: item.sourceId, relativePath: item.relativePath, code: item.code, message: item.message }]
    : [])
}

function machineEntry(value: unknown): MachineInstalledEntry | undefined {
  if (!record(value) || typeof value.name !== "string" || typeof value.root !== "string") return undefined
  return {
    name: value.name,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    root: value.root,
    ...(typeof value.marketplace === "string" ? { marketplace: value.marketplace } : {}),
    ownedByClaxedo: value.ownedByClaxedo === true,
  }
}

function machineHarness(value: unknown): MachineInstalledHarness | undefined {
  if (!record(value)) return undefined
  const harnessId = value.harnessId
  if (harnessId !== "claude" && harnessId !== "cursor" && harnessId !== "codex") return undefined
  const entries = Array.isArray(value.entries)
    ? value.entries.flatMap((entry) => {
        const parsed = machineEntry(entry)
        return parsed ? [parsed] : []
      })
    : []
  return { harnessId, entries }
}

async function failure(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => undefined)
  const error = record(body) && record(body.error) ? body.error : undefined
  const code = typeof error?.code === "string" ? error.code : `http_${response.status}`
  const message = typeof error?.message === "string" ? error.message : `${fallback} (${response.status})`
  return new DirectorySourceError(code, message, diagnostics(error?.["diagnostics"]))
}

/** The fetch-backed `DirectoryApi` half. Both rails serve the same paths. */
export function directoryApi(input: { baseUrl: string; request: RequestFn }): DirectoryApi {
  const url = (path: string) => new URL(`/api/claxedo/plugins${path}`, input.baseUrl)
  return {
    sources: {
      async list() {
        const response = await input.request(url("/sources"))
        if (!response.ok) throw await failure(response, "Sources request failed")
        const body: unknown = await response.json().catch(() => undefined)
        const rows = record(body) && Array.isArray(body.sources) ? body.sources : []
        return {
          sources: rows.flatMap((row) => {
            const source = directorySource(row)
            return source ? [source] : []
          }),
        }
      },
      async add(registration) {
        const response = await input.request(url("/sources"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(registration),
        })
        if (!response.ok) throw await failure(response, "Could not add source")
        const body: unknown = await response.json().catch(() => undefined)
        const source = record(body) ? directorySource(body.source) : undefined
        if (!source) throw new DirectorySourceError("invalid_response", "The source response did not match its API contract")
        return { source }
      },
      async remove(id) {
        const response = await input.request(url(`/sources/${encodeURIComponent(id)}`), { method: "DELETE" })
        if (!response.ok && response.status !== 404) throw await failure(response, "Could not remove source")
      },
    },
    async machineInstalled() {
      const response = await input.request(url("/machine-installed"))
      if (!response.ok) throw await failure(response, "Could not read this machine's harness installs")
      const body: unknown = await response.json().catch(() => undefined)
      const rows = record(body) && Array.isArray(body.harnesses) ? body.harnesses : []
      return {
        harnesses: rows.flatMap((row) => {
          const harness = machineHarness(row)
          return harness ? [harness] : []
        }),
      }
    },
  }
}
