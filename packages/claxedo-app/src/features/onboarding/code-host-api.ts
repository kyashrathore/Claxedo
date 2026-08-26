/**
 * The code host a cloud sandbox clones from.
 *
 * A cloud session starts from a git repository, not from the folder on this
 * machine — so setup has to know whether a code host is connected before it can
 * promise the cloud will work. This reads the same
 * `/api/claxedo/integrations` routes the Connections screen uses; onboarding
 * cannot import that feature, so the two share the wire format rather than code.
 */

/** Path is relative to the `/api/claxedo/integrations` mount ("" is the root list). */
export type CodeHostRequest = (path: string, init?: RequestInit) => Promise<Response>

export type CodeHostConnection = {
  id: string
  integrationId: string
  /** The account the token belongs to, e.g. a GitHub login. */
  accountLabel?: string
  status: "connected" | "degraded" | "broken"
}

export type CodeHostIntegration = {
  id: string
  name: string
  /** How this host can be connected. GitHub is key-only today. */
  methods: readonly ("key" | "oauth")[]
  prompts: readonly { id: string; label: string; placeholder?: string; secret: boolean }[]
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

export async function readCodeHostStatus(request: CodeHostRequest): Promise<CodeHostStatus> {
  const response = await request("")
  if (!response.ok) return { integrations: [], connections: [] }
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (!body) return { integrations: [], connections: [] }

  const integrations = asArray(body.integrations).flatMap(parseIntegration)
  const hostIds = new Set(integrations.map((integration) => integration.id))
  return {
    integrations,
    connections: asArray(body.connections)
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
  if (!value || typeof value !== "object") return []
  const integration = value as Record<string, unknown>
  if (typeof integration.id !== "string") return []
  const capabilities = asArray(integration.capabilities).filter((item): item is string => typeof item === "string")
  if (!capabilities.includes(CODE_HOST_CAPABILITY)) return []
  const methods = asArray(integration.methods).filter(
    (item): item is "key" | "oauth" => item === "key" || item === "oauth",
  )
  return [
    {
      id: integration.id,
      name: typeof integration.name === "string" ? integration.name : integration.id,
      methods,
      prompts: asArray(integration.prompts).flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const prompt = item as Record<string, unknown>
        if (typeof prompt.id !== "string") return []
        return [
          {
            id: prompt.id,
            label: typeof prompt.label === "string" ? prompt.label : prompt.id,
            ...(typeof prompt.placeholder === "string" ? { placeholder: prompt.placeholder } : {}),
            secret: prompt.secret === true,
          },
        ]
      }),
    },
  ]
}

function parseConnection(value: unknown): CodeHostConnection[] {
  if (!value || typeof value !== "object") return []
  const connection = value as Record<string, unknown>
  if (typeof connection.id !== "string" || typeof connection.integrationId !== "string") return []
  const status = connection.status
  return [
    {
      id: connection.id,
      integrationId: connection.integrationId,
      ...(typeof connection.accountLabel === "string" ? { accountLabel: connection.accountLabel } : {}),
      status: status === "connected" || status === "degraded" || status === "broken" ? status : "broken",
    },
  ]
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
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
      body: JSON.stringify(
        input.method === "oauth" ? { method: "oauth" } : { fields: input.fields ?? {}, secret: input.secret ?? "" },
      ),
    })
    const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
    if (!response.ok) return { ok: false, reason: codeHostFailureCopy(body, response.status) }
    if (input.method === "oauth" && typeof body?.url === "string" && typeof body.attemptId === "string") {
      return {
        ok: true,
        oauth: {
          url: body.url,
          attemptId: body.attemptId,
          ...(typeof body.userCode === "string" ? { userCode: body.userCode } : {}),
          ...(typeof body.intervalMs === "number" ? { intervalMs: body.intervalMs } : {}),
        },
      }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: "Couldn't reach the server to connect. Check your connection and try again." }
  }
}

export type CodeHostAttemptOutcome = { state: "pending" } | { state: "complete" } | { state: "failed"; reason: string }

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
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (body?.status === "pending") return { state: "pending" }
  if (body?.status === "complete") return { state: "complete" }
  if (body?.status === "expired") {
    return { state: "failed", reason: "That sign-in expired before it was approved. Start it again." }
  }
  return { state: "failed", reason: "That sign-in wasn't approved. Try again." }
}

/** Never surface a raw server code — say what happened and what repairs it. */
export function codeHostFailureCopy(body: Record<string, unknown> | undefined, status: number) {
  const code =
    typeof body?.code === "string"
      ? body.code
      : typeof (body?.error as Record<string, unknown> | undefined)?.code === "string"
        ? (body!.error as Record<string, string>).code
        : ""
  if (code === "connection_exists") return "This account is already connected."
  if (code === "verify_failed" || status === 401 || status === 403) {
    return "That token was rejected. Check it was copied whole and still has repository access, then try again."
  }
  if (status === 404) return "This server doesn't offer that code host."
  return "Couldn't connect that account. Try again."
}
