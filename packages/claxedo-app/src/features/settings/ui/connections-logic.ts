import { storePath } from "solid-js"
/**
 * Framework-light core for the Connections settings section: list store +
 * connect-flow state machine over the /api/claxedo/integrations route family.
 *
 * The HTTP seam is injected (`ConnectionsRequest`) so this module stays
 * testable with a mocked fetch and never touches auth helpers directly.
 * Secret hygiene: pasted secrets live only in flow state, are never copied
 * into error strings, and are cleared on success and on reset().
 */
import { createStore } from "solid-js"
import { createDraftReader } from "@/lib/store-draft"
import {
  SourceViewTargetSchema,
  type CreateSourceViewInput,
  type SourceViewDto,
  type SourceViewRefreshResponse,
  type UpdateSourceViewInput,
} from "@claxedo/workgraph/contracts"

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
  id: string
  integrationId: string
  scope: "team" | "personal"
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
  personalScopeEnabled: boolean
}

export function createConnectionsStore(options: { request: ConnectionsRequest }) {
  const [state, setState] = createStore<ConnectionsListState>({
    loading: false,
    loaded: false,
    error: undefined,
    integrations: [],
    connections: [],
    personalScopeEnabled: false,
  })

  async function load() {
    setState((state) => {
      Object.assign(state, { loading: true, error: undefined })
    })
    try {
      const response = await options.request("")
      if (!response.ok) {
        const body = await jsonOf(response)
        const code = typeof body.code === "string" ? body.code : `status ${response.status}`
        setState((state) => {
          Object.assign(state, { loading: false, error: `Failed to load connections (${code})` })
        })
        return
      }
      const body = await jsonOf(response)
      setState((state) => {
        Object.assign(state, {
          loading: false,
          loaded: true,
          error: undefined,
          integrations: Array.isArray(body.integrations) ? (body.integrations as IntegrationInfo[]) : [],
          connections: Array.isArray(body.connections) ? (body.connections as ConnectionInfo[]) : [],
          personalScopeEnabled: body.personalScopeEnabled === true,
        })
      })
    } catch (err) {
      setState((state) => {
        Object.assign(state, { loading: false, error: err instanceof Error ? err.message : String(err) })
      })
    }
  }

  const connectionsFor = (integrationId: string) =>
    state.connections.filter((connection) => connection.integrationId === integrationId)

  const connectionFor = (integrationId: string, scope: ConnectionInfo["scope"] = "team") =>
    connectionsFor(integrationId).find((connection) => connection.scope === scope)

  /** DELETE /connections/:id, then refresh the list. */
  async function disconnect(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await options.request(`/connections/${encodeURIComponent(id)}`, {
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
  async function reverify(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await options.request(`/connections/${encodeURIComponent(id)}/reverify`, {
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

  return { state, load, connectionFor, connectionsFor, disconnect, reverify }
}

export type ConnectionsStore = ReturnType<typeof createConnectionsStore>

export type SourceViewsPort = {
  list: () => Promise<{ sourceViews: SourceViewDto[] }>
  create: (input: CreateSourceViewInput) => Promise<SourceViewDto>
  update: (id: string, input: UpdateSourceViewInput) => Promise<SourceViewDto>
  delete: (id: string, expectedVersion: number) => Promise<SourceViewDto>
  refresh: (id: string) => Promise<SourceViewRefreshResponse>
}

export function createSourceViewsStore(port: SourceViewsPort) {
  const [state, setState] = createStore({
    loading: false,
    loaded: false,
    error: undefined as string | undefined,
    busy: undefined as string | undefined,
    views: [] as SourceViewDto[],
    refreshResult: {} as Record<string, string>,
  })

  async function load() {
    setState((state) => {
      Object.assign(state, { loading: true, error: undefined })
    })
    try {
      const result = await port.list()
      setState((state) => {
        Object.assign(state, { loading: false, loaded: true, views: result.sourceViews })
      })
    } catch (error) {
      setState((state) => {
        Object.assign(state, { loading: false, error: sourceViewError(error) })
      })
    }
  }

  async function mutate(id: string, operation: () => Promise<SourceViewDto>) {
    setState((state) => {
      Object.assign(state, { busy: id, error: undefined })
    })
    try {
      const view = await operation()
      setState(
        storePath("views", (current) =>
          current.some((entry) => entry.id === view.id)
            ? current.map((entry) => (entry.id === view.id ? view : entry))
            : [...current, view],
        ),
      )
      return true
    } catch (error) {
      setState(storePath("error", sourceViewError(error)))
      return false
    } finally {
      setState(storePath("busy", undefined))
    }
  }

  const create = (input: CreateSourceViewInput) => mutate("new", () => port.create(input))
  const update = (view: SourceViewDto, input: Omit<UpdateSourceViewInput, "expectedVersion">) =>
    mutate(view.id, () =>
      port.update(view.id, {
        ...input,
        filters: Object.fromEntries(Object.entries(input.filters)),
        ...(input.target ? { target: SourceViewTargetSchema.parse(input.target) } : {}),
        expectedVersion: view.version,
      }),
    )
  const remove = async (view: SourceViewDto) => {
    setState((state) => {
      Object.assign(state, { busy: view.id, error: undefined })
    })
    try {
      await port.delete(view.id, view.version)
      setState(storePath("views", (current) => current.filter((entry) => entry.id !== view.id)))
      return true
    } catch (error) {
      setState(storePath("error", sourceViewError(error)))
      return false
    } finally {
      setState(storePath("busy", undefined))
    }
  }
  const refresh = async (view: SourceViewDto) => {
    setState((state) => {
      Object.assign(state, { busy: view.id, error: undefined })
    })
    try {
      const result = await port.refresh(view.id)
      setState(storePath("refreshResult", view.id, `${result.created} new · ${result.updated} updated`))
      return true
    } catch (error) {
      setState(storePath("error", sourceViewError(error)))
      return false
    } finally {
      setState(storePath("busy", undefined))
    }
  }

  return { state, load, create, update, remove, refresh }
}

function sourceViewError(error: unknown) {
  if (!error || typeof error !== "object") return "Source view request failed"
  if ("code" in error && error.code === "source_issue_provider_unauthorized")
    return "This account needs to be reconnected before issues can refresh."
  if ("code" in error && error.code === "source_view_version_conflict")
    return "This source view changed elsewhere. Reload and try again."
  if (
    "code" in error &&
    typeof error.code === "string" &&
    (error.code.startsWith("source_issue_") || error.code.startsWith("source_view_"))
  ) {
    return "The issue source could not be updated. Check the account and mapping, then try again."
  }
  if ("message" in error && typeof error.message === "string") return error.message
  return "Source view request failed"
}

// ── Connect flow ────────────────────────────────────────────────────────────

export type ConnectFlowPhase = "form" | "submitting" | "confirm-replace" | "oauth-waiting" | "done"

export type ConnectFlowState = {
  phase: ConnectFlowPhase
  error: string | undefined
  fields: Record<string, string>
  secret: string
  scope: "team" | "personal"
  /** Which submission the confirm-replace prompt would retry. */
  pendingMode: "key" | "oauth" | undefined
  /**
   * The device-flow code the user must type at the provider's verification page.
   *
   * A device grant is not a redirect: opening `url` lands the user on
   * github.com/login/device, which asks for a code that ONLY this response
   * carries. Dropping it — as this flow used to — left the UI spinning
   * "Waiting for authorization…" next to a page the user could not get past,
   * so the flow could never complete no matter how long it polled.
   */
  userCode: string | undefined
  /** The verification page to open; kept so the user can re-open it. */
  verificationUrl: string | undefined
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
  /** Signed hosts enable a user choice; unsigned-local stays team-only. */
  personalScopeEnabled?: boolean
  initialScope?: "team" | "personal"
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
    scope: options.personalScopeEnabled ? (options.initialScope ?? "team") : "team",
    pendingMode: undefined,
    userCode: undefined,
    verificationUrl: undefined,
  })
  const draft = createDraftReader<ConnectFlowState>(setState)
  // Bumped by reset(); in-flight oauth polling stops when its generation is stale.
  let generation = 0

  const setField = (id: string, value: string) => setState(storePath("fields", id, value))
  const setSecret = (value: string) => setState(storePath("secret", value))
  const setScope = (scope: "team" | "personal") => {
    if (scope === "personal" && !options.personalScopeEnabled) return
    setState(storePath("scope", scope))
  }

  async function succeed() {
    setState((state) => {
      Object.assign(state, {
        phase: "done",
        error: undefined,
        secret: "",
        pendingMode: undefined,
        userCode: undefined,
        verificationUrl: undefined,
      })
    })
    await options.onConnected?.()
  }

  async function pollAttempt(attemptId: string, initialIntervalMs?: number) {
    const myGeneration = generation
    setState((state) => {
      Object.assign(state, { phase: "oauth-waiting", error: undefined, pendingMode: undefined })
    })
    // The provider dictates the device-flow cadence and may raise it mid-flow
    // (GitHub's `slow_down`), which the server relays as `intervalMs`. Polling
    // faster than asked earns rate limiting, so the server's number wins
    // whenever it gives one.
    let interval = initialIntervalMs && initialIntervalMs > 0 ? initialIntervalMs : pollIntervalMs
    for (let i = 0; i < maxPolls; i++) {
      await sleep(interval)
      if (generation !== myGeneration) return
      let response: Response
      try {
        response = await options.request(`/attempts/${encodeURIComponent(attemptId)}`)
      } catch {
        continue
      }
      if (generation !== myGeneration) return
      if (!response.ok) {
        setState((state) => {
          Object.assign(state, {
            phase: "form",
            error: "The authorization attempt was not found or expired. Try again.",
          })
        })
        return
      }
      const body = await jsonOf(response)
      if (body.status === "pending") {
        if (typeof body.intervalMs === "number" && body.intervalMs > 0) interval = body.intervalMs
        continue
      }
      if (body.status === "complete") {
        await succeed()
        return
      }
      setState((state) => {
        Object.assign(state, {
          phase: "form",
          error:
            body.status === "expired"
              ? "The authorization attempt expired. Try again."
              : "Authorization failed. Try again.",
        })
      })
      return
    }
    if (generation === myGeneration) {
      setState((state) => {
        Object.assign(state, { phase: "form", error: "Timed out waiting for authorization. Try again." })
      })
    }
  }

  async function submit(mode: "key" | "oauth", confirmReplace: boolean) {
    // Built from the DRAFT, not from committed state. `setField`/`setSecret`/
    // `setScope` and this call can land in the same task — an Enter keypress
    // that fills the secret and submits, or a form handler that does both — and
    // Solid 2 stages store writes until the scheduler flushes, so a committed
    // read here sends the pre-edit values. Everything pulled out is a string, so
    // it is safe to carry out of the callback.
    const body = draft(($state): Record<string, unknown> => {
      const next: Record<string, unknown> = {
        ...(confirmReplace ? { confirmReplace: true } : {}),
        ...(options.personalScopeEnabled ? { scope: $state.scope } : {}),
      }
      if (mode === "oauth") {
        next.method = "oauth"
        return next
      }
      const fields: Record<string, string> = {}
      for (const prompt of options.integration.prompts ?? []) {
        if (prompt.secret) continue
        fields[prompt.id] = $state.fields[prompt.id] ?? ""
      }
      next.fields = fields
      next.secret = $state.secret
      return next
    })

    setState((state) => {
      Object.assign(state, { phase: "submitting", error: undefined })
    })
    let response: Response
    try {
      response = await options.request(`/${encodeURIComponent(options.integration.id)}/connect`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    } catch (err) {
      setState((state) => {
        Object.assign(state, { phase: "form", error: err instanceof Error ? err.message : String(err) })
      })
      return
    }

    const payload = await jsonOf(response)
    if (response.status === 409 && payload.code === "connection_exists") {
      setState((state) => {
        Object.assign(state, { phase: "confirm-replace", error: undefined, pendingMode: mode })
      })
      return
    }
    if (!response.ok) {
      if (payload.code === "connection_verify_failed") {
        setState((state) => {
          Object.assign(state, { phase: "form", error: verifyFailedMessage(payload.reason) })
        })
        return
      }
      const code = typeof payload.code === "string" ? payload.code : `status ${response.status}`
      setState((state) => {
        Object.assign(state, { phase: "form", error: `Connect failed (${code})` })
      })
      return
    }

    if (mode === "oauth") {
      const url = typeof payload.url === "string" ? payload.url : undefined
      const attemptId = typeof payload.attemptId === "string" ? payload.attemptId : undefined
      if (!url || !attemptId) {
        setState((state) => {
          Object.assign(state, { phase: "form", error: "The server did not return an authorization URL. Try again." })
        })
        return
      }
      // Present only for a device grant. The redirect flow leaves both
      // undefined, and the dialog renders its plain "waiting" copy.
      const userCode = typeof payload.userCode === "string" ? payload.userCode : undefined
      const intervalMs = typeof payload.intervalMs === "number" ? payload.intervalMs : undefined
      setState((state) => {
        Object.assign(state, { userCode, verificationUrl: url })
      })
      options.openUrl?.(url)
      await pollAttempt(attemptId, intervalMs)
      return
    }

    await succeed()
  }

  /** Submit the key-method form (fields + secret from prompts). */
  const submitKey = () => {
    if (!draft(($state) => $state.secret.trim())) {
      setState(storePath("error", "Enter the required secret before connecting."))
      return Promise.resolve()
    }
    return submit("key", false)
  }

  /** Start the oauth flow ("Continue with OAuth"). */
  const startOAuth = () => submit("oauth", false)

  /** Re-submit the pending mode with confirmReplace: true (after a 409). */
  const confirmReplace = () => {
    const mode = draft(($state) => $state.pendingMode)
    if (!mode) return Promise.resolve()
    return submit(mode, true)
  }

  const cancelReplace = () => {
    setState((state) => {
      Object.assign(state, { phase: "form", error: undefined, pendingMode: undefined })
    })
  }

  /** Clears everything (including the secret) and cancels in-flight polling. */
  const reset = () => {
    generation++
    setState((state) => {
      Object.assign(state, {
        phase: "form",
        error: undefined,
        fields: {},
        secret: "",
        scope: options.personalScopeEnabled ? (options.initialScope ?? "team") : "team",
        pendingMode: undefined,
        userCode: undefined,
        verificationUrl: undefined,
      })
    })
  }

  return { state, setField, setSecret, setScope, submitKey, startOAuth, confirmReplace, cancelReplace, reset }
}

export type ConnectFlow = ReturnType<typeof createConnectFlow>
