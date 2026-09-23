import { isRecord, readArray, readField, readString } from "@/lib/record"
import { isAgentPluginSourceKind, type AgentPluginHarness, type AgentPluginSourceKind } from "../api"

/**
 * The reads the Directory needs beyond the catalog itself: the sources a
 * catalog is assembled from, and what the harnesses on this machine installed
 * on their own.
 *
 * `machineInstalled` is a LOCAL-rail read: only the machine's own sidecar can
 * see the harness directories under the user's home. Composition passes a signed
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

/** A harness that keeps a machine-wide skills directory the sidecar scans. */
export type MachineSkillHarnessId = Extract<AgentPluginHarness, "claude" | "cursor" | "codex" | "opencode"> | "agents"

/** One `SKILL.md` folder a harness carries, discovered on this machine. */
export type MachineSkill = {
  name: string
  harnessId: MachineSkillHarnessId
  root: string
}

export type MachineInstalled = { harnesses: MachineInstalledHarness[]; skills: MachineSkill[] }

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

function directorySource(value: unknown): DirectorySource | undefined {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !isAgentPluginSourceKind(value.kind)
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
  return value.flatMap((item) => isRecord(item)
    && typeof item.sourceId === "string"
    && typeof item.relativePath === "string"
    && typeof item.code === "string"
    && typeof item.message === "string"
    ? [{ sourceId: item.sourceId, relativePath: item.relativePath, code: item.code, message: item.message }]
    : [])
}

function machineEntry(value: unknown): MachineInstalledEntry | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.root !== "string") return undefined
  return {
    name: value.name,
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    root: value.root,
    ...(typeof value.marketplace === "string" ? { marketplace: value.marketplace } : {}),
    ownedByClaxedo: value.ownedByClaxedo === true,
  }
}

function machineHarness(value: unknown): MachineInstalledHarness | undefined {
  if (!isRecord(value)) return undefined
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

export function directorySourceFailure(status: number, body: unknown, fallback: string): DirectorySourceError {
  const error = readField(body, "error")
  const code = readString(error, "code") ?? `http_${status}`
  const message = readString(error, "message") ?? `${fallback} (${status})`
  return new DirectorySourceError(code, message, diagnostics(readField(error, "diagnostics")))
}

const MACHINE_SKILL_HARNESSES: readonly MachineSkillHarnessId[] = ["claude", "cursor", "codex", "opencode", "agents"]

function machineSkill(value: unknown): MachineSkill | undefined {
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.root !== "string") return undefined
  const harnessId = MACHINE_SKILL_HARNESSES.find((id) => id === value.harnessId)
  return harnessId ? { name: value.name, harnessId, root: value.root } : undefined
}

export function parseDirectorySourceList(body: unknown): { sources: DirectorySource[] } {
  const rows = readArray(body, "sources") ?? []
  return { sources: rows.flatMap((row) => {
    const source = directorySource(row)
    return source ? [source] : []
  }) }
}

export function parseDirectorySourceResponse(body: unknown): { source: DirectorySource } {
  const source = directorySource(readField(body, "source"))
  if (!source) throw new DirectorySourceError("invalid_response", "The source response did not match its API contract")
  return { source }
}

async function failure(response: Response, fallback: string) {
  return directorySourceFailure(response.status, await response.json().catch(() => undefined), fallback)
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
        return parseDirectorySourceList(body)
      },
      async add(registration) {
        const response = await input.request(url("/sources"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(registration),
        })
        if (!response.ok) throw await failure(response, "Could not add source")
        const body: unknown = await response.json().catch(() => undefined)
        return parseDirectorySourceResponse(body)
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
      const rows = readArray(body, "harnesses") ?? []
      const skillRows = readArray(body, "skills") ?? []
      return {
        harnesses: rows.flatMap((row) => {
          const harness = machineHarness(row)
          return harness ? [harness] : []
        }),
        skills: skillRows.flatMap((row) => {
          const skill = machineSkill(row)
          return skill ? [skill] : []
        }),
      }
    },
  }
}
