/**
 * The code host a cloud sandbox clones from.
 *
 * A cloud session starts from a git repository, not from the folder on this
 * machine — so setup has to know whether a code host is connected before it can
 * promise the cloud will work. This reads the same
 * `/api/claxedo/integrations` routes the Connections screen uses; onboarding
 * cannot import that feature, so the two share the wire format rather than code.
 */
import { asRecord, readArray, readBoolean, readField, readFiniteNumber, readString } from "@/lib/record"

/** Path is relative to the `/api/claxedo/integrations` mount ("" is the root list). */
export type CodeHostRequest = (path: string, init?: RequestInit) => Promise<Response>

export type CodeHostConnection = {
  id: string
  integrationId: string
  /** The account the token belongs to, e.g. a GitHub login. */
  accountLabel?: string
  status: "connected" | "degraded" | "broken"
}

/** One field the connect form asks for before a key-based host can be connected. */
export type CodeHostPrompt = { id: string; label: string; placeholder?: string; secret: boolean }

export type CodeHostIntegration = {
  id: string
  name: string
  /** How this host can be connected. GitHub is key-only today. */
  methods: readonly ("key" | "oauth")[]
  prompts: readonly CodeHostPrompt[]
}

export type CodeHostStatus = {
  /** Hosts that can be connected on this server, in catalog order. */
  integrations: readonly CodeHostIntegration[]
  /** Existing connections, including degraded ones — a broken token is not a missing one. */
  connections: readonly CodeHostConnection[]
}

/**
 * Only hosts that can actually serve a clone. The capability string is the
 * server's own term for it, so a host gaining or losing the ability shows up
 * here without a second list to keep in step.
 */
const CODE_HOST_CAPABILITY = "code-host"

/**
 * A request that never lands reads the same as a server with no code host:
 * the caller's only answer to either is the URL field, which clones without one.
 */
export async function readCodeHostStatus(request: CodeHostRequest): Promise<CodeHostStatus> {
  let response: Response
  try {
    response = await request("")
  } catch {
    return { integrations: [], connections: [] }
  }
  if (!response.ok) return { integrations: [], connections: [] }
  const body = asRecord(await response.json().catch(() => undefined))
  if (!body) return { integrations: [], connections: [] }

  const integrations = (readArray(body, "integrations") ?? []).flatMap(parseIntegration)
  const hostIds = new Set(integrations.map((integration) => integration.id))
  return {
    integrations,
    connections: (readArray(body, "connections") ?? [])
      .flatMap(parseConnection)
      .filter((connection) => hostIds.has(connection.integrationId)),
  }
}

/**
 * A degraded connection still names an account and can be repaired, so it
 * counts as connected for the purpose of "can the cloud clone anything?" — the
 * repair belongs on the row, not in a gate that hides the whole step.
 */
export function connectedCodeHosts(status: CodeHostStatus) {
  return status.connections.filter((connection) => connection.status !== "broken")
}

export function hasConnectedCodeHost(status: CodeHostStatus) {
  return connectedCodeHosts(status).length > 0
}

function parseIntegration(value: unknown): CodeHostIntegration[] {
  const id = readString(value, "id")
  if (id === undefined) return []
  const capabilities = (readArray(value, "capabilities") ?? []).filter((item): item is string => typeof item === "string")
  if (!capabilities.includes(CODE_HOST_CAPABILITY)) return []
  const methods = (readArray(value, "methods") ?? [])
    .filter((item): item is "key" | "oauth" => item === "key" || item === "oauth")
  return [{
    id,
    name: readString(value, "name") ?? id,
    methods,
    prompts: (readArray(value, "prompts") ?? []).flatMap(parsePrompt),
  }]
}

function parsePrompt(value: unknown): CodeHostPrompt[] {
  const id = readString(value, "id")
  if (id === undefined) return []
  const placeholder = readString(value, "placeholder")
  return [{
    id,
    label: readString(value, "label") ?? id,
    ...(placeholder === undefined ? {} : { placeholder }),
    secret: readBoolean(value, "secret") === true,
  }]
}

function parseConnection(value: unknown): CodeHostConnection[] {
  const id = readString(value, "id")
  const integrationId = readString(value, "integrationId")
  if (id === undefined || integrationId === undefined) return []
  const accountLabel = readString(value, "accountLabel")
  const status = readString(value, "status")
  return [{
    id,
    integrationId,
    ...(accountLabel === undefined ? {} : { accountLabel }),
    status: status === "connected" || status === "degraded" || status === "broken" ? status : "broken",
  }]
}

export type CodeHostConnectOutcome =
  | { ok: true }
  /**
   * An OAuth host hands back a URL to open and an attempt to poll. A device
   * grant (GitHub's) adds the code the user types into that page — the page
   * cannot be completed without it — and the interval the provider asked to be
   * polled at.
   */
  | { ok: true; oauth: { url: string; attemptId: string; userCode?: string; intervalMs?: number } }
  | { ok: false; reason: string }

export async function connectCodeHost(input: {
  request: CodeHostRequest
  integrationId: string
  method: "key" | "oauth"
  fields?: Record<string, string>
  secret?: string
}): Promise<CodeHostConnectOutcome> {
  try {
    const response = await input.request(`/${encodeURIComponent(input.integrationId)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.method === "oauth"
        ? { method: "oauth" }
        : { fields: input.fields ?? {}, secret: input.secret ?? "" }),
    })
    const body = asRecord(await response.json().catch(() => undefined))
    if (!response.ok) return { ok: false, reason: codeHostFailureCopy(body, response.status) }
    const url = readString(body, "url")
    const attemptId = readString(body, "attemptId")
    if (input.method === "oauth" && url !== undefined && attemptId !== undefined) {
      const userCode = readString(body, "userCode")
      const intervalMs = readFiniteNumber(body, "intervalMs")
      return {
        ok: true,
        oauth: {
          url,
          attemptId,
          ...(userCode === undefined ? {} : { userCode }),
          ...(intervalMs === undefined ? {} : { intervalMs }),
        },
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: "Couldn't reach the server to connect. Check your connection and try again." }
  }
}

export type CodeHostAttemptOutcome =
  | { state: "pending" }
  | { state: "complete" }
  | { state: "failed"; reason: string }

/**
 * Asks once whether a device grant has been authorized yet.
 *
 * Each call also ADVANCES the grant server-side — the server polls GitHub when
 * this route is read, because a device flow has no callback to settle it. So
 * the caller's polling interval is the real one, and the server's suggested
 * `intervalMs` is what it should honour.
 *
 * A request that never lands reads as pending on purpose: a dropped poll says
 * nothing about the user's choice, and treating it as failure would cancel a
 * grant the user is midway through approving.
 */
export async function readCodeHostAttempt(
  request: CodeHostRequest,
  attemptId: string,
): Promise<CodeHostAttemptOutcome> {
  let response: Response
  try {
    response = await request(`/attempts/${encodeURIComponent(attemptId)}`)
  } catch {
    return { state: "pending" }
  }
  if (!response.ok) {
    return { state: "failed", reason: "That sign-in attempt is no longer available. Start it again." }
  }
  const status = readString(await response.json().catch(() => undefined), "status")
  if (status === "pending") return { state: "pending" }
  if (status === "complete") return { state: "complete" }
  if (status === "expired") {
    return { state: "failed", reason: "That sign-in expired before it was approved. Start it again." }
  }
  return { state: "failed", reason: "That sign-in wasn't approved. Try again." }
}

export type CodeHostRepository = {
  id: string
  name: string
  /** `owner/name`, the form a clone is asked for by. */
  fullName: string
  cloneUrl: string
  private: boolean
  permissions: { read: boolean; write: boolean }
}

export type CodeHostRepositoryList =
  | { ok: true; repositories: CodeHostRepository[] }
  | { ok: false; reason: string }

/**
 * The connected account's repositories, in the server's order (the host's
 * "recently updated" — the ones the user most likely came for sit first, so
 * the list is not re-sorted here).
 */
export async function listCodeHostRepositories(
  request: CodeHostRequest,
  connectionId: string,
): Promise<CodeHostRepositoryList> {
  let response: Response
  try {
    response = await request(`/connections/${encodeURIComponent(connectionId)}/repositories`)
  } catch {
    return { ok: false, reason: "Couldn't reach the server to list repositories. Check your connection and try again." }
  }
  const body = asRecord(await response.json().catch(() => undefined))
  if (!response.ok) return { ok: false, reason: repositoryListFailureCopy(body, response.status) }
  return { ok: true, repositories: (readArray(body, "repositories") ?? []).flatMap(parseRepository) }
}

function parseRepository(value: unknown): CodeHostRepository[] {
  const id = readString(value, "id")
  const name = readString(value, "name")
  const fullName = readString(value, "fullName")
  const cloneUrl = readString(value, "cloneUrl")
  if (id === undefined || name === undefined || fullName === undefined || cloneUrl === undefined) return []
  const permissions = readField(value, "permissions")
  return [{
    id,
    name,
    fullName,
    cloneUrl,
    private: readBoolean(value, "private") === true,
    permissions: {
      read: readBoolean(permissions, "read") === true,
      write: readBoolean(permissions, "write") === true,
    },
  }]
}

function repositoryListFailureCopy(body: Record<string, unknown> | undefined, status: number) {
  const code = readString(body, "code") ?? ""
  if (code === "repository_listing_unsupported") return "This code host can't list repositories here. Paste a URL instead."
  if (code === "connection_not_found") return "That connection is gone. Connect the account again."
  if (status === 401 || status === 403 || code === "repository_provider_unauthorized") {
    return "That token was rejected. Reconnect the account in Settings, or paste a URL instead."
  }
  if (status === 502) return "The code host didn't answer. Try again in a moment, or paste a URL instead."
  return "Couldn't list repositories. Try again, or paste a URL instead."
}

/** Never surface a raw server code — say what happened and what repairs it. */
export function codeHostFailureCopy(body: Record<string, unknown> | undefined, status: number) {
  const code = readString(body, "code") ?? readString(readField(body, "error"), "code") ?? ""
  if (code === "connection_exists") return "This account is already connected."
  if (code === "verify_failed" || status === 401 || status === 403) {
    return "That token was rejected. Check it was copied whole and still has repository access, then try again."
  }
  if (status === 404) return "This server doesn't offer that code host."
  return "Couldn't connect that account. Try again."
}
