/**
 * Framework-light core for the Connections settings section: list store +
 * connect-flow state machine over the /api/claxedo/integrations route family.
 *
 * The HTTP seam is injected (`ConnectionsRequest`) so this module stays
 * testable with a mocked fetch and never touches auth helpers directly.
 * Secret hygiene: pasted secrets live only in flow state, are never copied
 * into error strings, and are cleared on success and on reset().
 */
import { createStore } from "solid-js/store"

export type IntegrationPrompt = {
  id: string
  label: string
  placeholder?: string
  secret?: boolean
}

export type IntegrationInfo = {
  id: string
  name: string
  methods: ("key" | "oauth")[]
  capabilities: string[]
  prompts?: IntegrationPrompt[]
}

export type ConnectionInfo = {
  integrationId: string
  accountLabel?: string
  grantedCapabilities: string[]
  fields: Record<string, string>
  status: "connected" | "degraded" | "broken"
  createdAt: number
  updatedAt: number
}

/** Path is relative to the /api/claxedo/integrations mount ("" for the root list). */
export type ConnectionsRequest = (path: string, init?: RequestInit) => Promise<Response>

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json().catch(() => undefined)
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
}

function verifyFailedMessage(reason: unknown): string {
  if (reason === "unauthorized") return "The provided credentials were rejected. Check the values and try again."
  if (reason === "network") return "Could not reach the integration to verify the credentials. Try again."
  return "Verification failed. Try again."
}

// ── List store ──────────────────────────────────────────────────────────────

export type ConnectionsListState = {
  loading: boolean
  loaded: boolean
  error: string | undefined
  integrations: IntegrationInfo[]
  connections: ConnectionInfo[]
}

export function createConnectionsStore(options: { request: ConnectionsRequest }) {
  const [state, setState] = createStore<ConnectionsListState>({
    loading: false,
    loaded: false,
    error: undefined,
    integrations: [],
    connections: [],
  })

  async function load() {
    setState({ loading: true, error: undefined })
    try {
      const response = await options.request("")
      if (!response.ok) {
        const body = await jsonOf(response)
        const code = typeof body.code === "string" ? body.code : `status ${response.status}`
        setState({ loading: false, error: `Failed to load connections (${code})` })
        return
      }
      const body = await jsonOf(response)
      setState({
        loading: false,
        loaded: true,
        error: undefined,
        integrations: Array.isArray(body.integrations) ? (body.integrations as IntegrationInfo[]) : [],
        connections: Array.isArray(body.connections) ? (body.connections as ConnectionInfo[]) : [],
      })
    } catch (err) {
      setState({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const connectionFor = (integrationId: string) =>
    state.connections.find((connection) => connection.integrationId === integrationId)

  /** DELETE /connections/:id, then refresh the list. */
  async function disconnect(integrationId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await options.request(`/connections/${encodeURIComponent(integrationId)}`, {
        method: "DELETE",
      })
      if (!response.ok && response.status !== 404) {
        return { ok: false, error: `Disconnect failed (status ${response.status})` }
      }
      await load()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** POST /connections/:id/reverify, then refresh the list. */
  async function reverify(integrationId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await options.request(`/connections/${encodeURIComponent(integrationId)}/reverify`, {
        method: "POST",
      })
      const body = await jsonOf(response)
      await load()
      if (response.ok && body.ok === true) return { ok: true }
      return { ok: false, error: verifyFailedMessage(body.reason) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { state, load, connectionFor, disconnect, reverify }
}

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>

// ── Connect flow ────────────────────────────────────────────────────────────

export type ConnectFlowPhase = "form" | "submitting" | "confirm-replace" | "oauth-waiting" | "done"

export type ConnectFlowState = {
  phase: ConnectFlowPhase
  error: string | undefined
  fields: Record<string, string>
  secret: string
  /** Which submission the confirm-replace prompt would retry. */
  pendingMode: "key" | "oauth" | undefined
}

export type ConnectFlowOptions = {
  integration: IntegrationInfo
  request: ConnectionsRequest
  /** Called once after a successful connect (key verify or oauth completion). */
  onConnected?: () => void | Promise<void>
  /** Defaults to window.open in the component; injectable for tests. */
  openUrl?: (url: string) => void
  /** Injectable delay for oauth polling; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  /** Safety cap on attempt polls before giving up. */
  maxPolls?: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function isOAuthOnly(integration: IntegrationInfo): boolean {
  return integration.methods.includes("oauth") && !(integration.prompts && integration.prompts.length > 0)
}

export function createConnectFlow(options: ConnectFlowOptions) {
  const sleep = options.sleep ?? defaultSleep
  const pollIntervalMs = options.pollIntervalMs ?? 2000
  const maxPolls = options.maxPolls ?? 150
  const [state, setState] = createStore<ConnectFlowState>({
    phase: "form",
    error: undefined,
    fields: {},
    secret: "",
    pendingMode: undefined,
  })
  // Bumped by reset(); in-flight oauth polling stops when its generation is stale.
  let generation = 0

  const setField = (id: string, value: string) => setState("fields", id, value)
  const setSecret = (value: string) => setState("secret", value)

  async function succeed() {
    setState({ phase: "done", error: undefined, secret: "", pendingMode: undefined })
    await options.onConnected?.()
  }

  async function pollAttempt(attemptId: string) {
    const myGeneration = generation
    setState({ phase: "oauth-waiting", error: undefined, pendingMode: undefined })
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollIntervalMs)
      if (generation !== myGeneration) return
      let response: Response
      try {
        response = await options.request(`/attempts/${encodeURIComponent(attemptId)}`)
      } catch {
        continue
      }
      if (generation !== myGeneration) return
      if (!response.ok) {
        setState({ phase: "form", error: "The authorization attempt was not found or expired. Try again." })
        return
      }
      const body = await jsonOf(response)
      if (body.status === "pending") continue
      if (body.status === "complete") {
        await succeed()
        return
      }
      setState({
        phase: "form",
        error: body.status === "expired" ? "The authorization attempt expired. Try again." : "Authorization failed. Try again.",
      })
      return
    }
    if (generation === myGeneration) {
      setState({ phase: "form", error: "Timed out waiting for authorization. Try again." })
    }
  }

  async function submit(mode: "key" | "oauth", confirmReplace: boolean) {
    const body: Record<string, unknown> = confirmReplace ? { confirmReplace: true } : {}
    if (mode === "oauth") {
      body.method = "oauth"
    } else {
      const fields: Record<string, string> = {}
      for (const prompt of options.integration.prompts ?? []) {
        if (prompt.secret) continue
        fields[prompt.id] = state.fields[prompt.id] ?? ""
      }
      body.fields = fields
      body.secret = state.secret
    }

    setState({ phase: "submitting", error: undefined })
    let response: Response
    try {
      response = await options.request(`/${encodeURIComponent(options.integration.id)}/connect`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    } catch (err) {
      setState({ phase: "form", error: err instanceof Error ? err.message : String(err) })
      return
    }

    const payload = await jsonOf(response)
    if (response.status === 409 && payload.code === "connection_exists") {
      setState({ phase: "confirm-replace", error: undefined, pendingMode: mode })
      return
    }
    if (!response.ok) {
      if (payload.code === "connection_verify_failed") {
        setState({ phase: "form", error: verifyFailedMessage(payload.reason) })
        return
      }
      const code = typeof payload.code === "string" ? payload.code : `status ${response.status}`
      setState({ phase: "form", error: `Connect failed (${code})` })
      return
    }

    if (mode === "oauth") {
      const url = typeof payload.url === "string" ? payload.url : undefined
      const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : undefined
      if (!url || !attemptId) {
        setState({ phase: "form", error: "The server did not return an authorization URL. Try again." })
        return
      }
      options.openUrl?.(url)
      await pollAttempt(attemptId)
      return
    }

    await succeed()
  }

  /** Submit the key-method form (fields + secret from prompts). */
  const submitKey = () => {
    if (!state.secret.trim()) {
      setState("error", "Enter the required secret before connecting.")
      return Promise.resolve()
    }
    return submit("key", false)
  }

  /** Start the oauth flow ("Continue with OAuth"). */
  const startOAuth = () => submit("oauth", false)

  /** Re-submit the pending mode with confirmReplace: true (after a 409). */
  const confirmReplace = () => {
    const mode = state.pendingMode
    if (!mode) return Promise.resolve()
    return submit(mode, true)
  }

  const cancelReplace = () => {
    setState({ phase: "form", error: undefined, pendingMode: undefined })
  }

  /** Clears everything (including the secret) and cancels in-flight polling. */
  const reset = () => {
    generation++
    setState({ phase: "form", error: undefined, fields: {}, secret: "", pendingMode: undefined })
  }

  return { state, setField, setSecret, submitKey, startOAuth, confirmReplace, cancelReplace, reset }
}

export type ConnectFlow = ReturnType<typeof createConnectFlow>
