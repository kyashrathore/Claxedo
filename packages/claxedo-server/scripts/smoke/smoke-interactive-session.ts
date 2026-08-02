/**
 * Staging deploy smoke — INTERACTIVE hosted Session.
 *
 * The WorkGraph smoke (`smoke-workgraph.ts`) proves the durable *managed* Run
 * path: a Stream is created, continuous execution admits a Run, the hosted
 * reconciler drives it, and a durable transcript is retained. That path is
 * server-driven end to end. It says nothing about the path a human takes.
 *
 * This smoke covers the other half — the surface the app drives directly:
 *
 *   1. mint a signed Clerk session for smoke user A (same fixture flow),
 *   2. create a CLOUD workspace and poll its connection until a sandbox is
 *      ready (this is the app's own `/connection` provisioning loop),
 *   3. open a Session V2 session on the workspace runtime THROUGH THE RELAY,
 *      at the relay URL and with the runtime access token the control plane
 *      minted — the exact transport the app uses
 *      (`platform/runtime/agent/workspace-relay-connection.ts:352`),
 *   4. send one short prompt with a real provider turn (staging carries real
 *      provider credentials; there is no scripted endpoint on the CF lane —
 *      `runtimeEnvForHost` has no sandbox env passthrough),
 *   5. wait for the turn to SETTLE, and assert the model's reply carries the
 *      run's marker token.
 *
 * A deploy that cannot complete an interactive turn now fails here.
 *
 * ## The settled signal
 *
 * `session.next.prompted` fires the moment a prompt is ADMITTED; the first
 * `session.next.step.ended` lands whole seconds later, so Session history
 * ALONE cannot distinguish "stopped" from "mid-turn". That mistake parked
 * every hosted Run reconciled inside that window and kept this workflow red
 * for four days (`hosted-runtime.ts:600-626` carries the fix and the story).
 *
 * So settlement here is the same two-source conjunction the product uses:
 *
 *   - history holds a terminal step (`session.next.step.ended` /
 *     `session.next.step.failed`), AND
 *   - `GET /api/session/active` no longer lists the session. That route is the
 *     harness process's own answer about which drains it owns
 *     (`{ data: { [sessionID]: { type: "running" } } }` —
 *     `packages/protocol/src/groups/session.ts:159`); a session absent from it
 *     is inactive. A malformed envelope reads as STILL ACTIVE, never as idle,
 *     because that is the direction that does not declare live work finished.
 *
 * The same two sources also catch the OPPOSITE failure: a prompt admitted, no
 * terminal step, and no active drain means the harness took the work and
 * stopped. That fails immediately rather than polling out the budget, because
 * a six-minute timeout says nothing about why. See `classifyTurn`.
 *
 * ## Production-length session id
 *
 * The id below is deliberately ~230 characters. The engine's router
 * (`find-my-way`) silently refuses to match a path parameter longer than
 * `maxParamLength`, answering a bare bodyless 404 that reads as "the session
 * vanished". Real WorkGraph session ids run ~250 chars, and that bug reached
 * staging precisely because every smoke used a short id
 * (`packages/server/src/router-config.ts` raises the ceiling to 1024; the
 * sandbox image smoke uses the same ~226-char shape). A short id here would
 * re-open that blind spot.
 */

type SmokeEnvironment = Readonly<Record<string, string | undefined>>

type Session = Readonly<{ id: string; organizationId: string }>

type Connection = Readonly<{
  relayUrl: string
  runtimeAccessToken: string
  workspaceId: string
  tokenExpiresAt?: number
}>

type SessionEvent = Readonly<{ type: string; data: Record<string, unknown>; durable?: { seq?: number } }>

/** Overall budget for provisioning + the turn. The CI step allows 10 minutes. */
const SMOKE_DEADLINE_MS = 6 * 60_000
/** Per-request ceiling. Nothing here legitimately takes longer than this. */
const REQUEST_TIMEOUT_MS = 30_000
/** Cold sandbox starts are minutes, not seconds; this is the provisioning slice. */
const PROVISION_BUDGET_MS = 4 * 60_000

export function markerToken(runId: string) {
  return `SMOKE-${runId}`
}

/**
 * The runtime access token is minted with a signer-enforced TTL floor of 15
 * minutes (`control-plane/runtime-access-token.ts:51`), so a single token
 * comfortably outlives what remains of this smoke's budget once the sandbox is
 * ready — which is why there is no rotation loop here, unlike the app, whose
 * sessions are open-ended (`workspace-relay-connection.ts:315`).
 *
 * That is an assumption about a value configured elsewhere, so it is CHECKED
 * rather than trusted: if a deployment ever shortens the TTL below the
 * remaining budget, this says so in one line instead of surfacing as an
 * inexplicable 401 partway through the poll loop.
 */
export function tokenLifetimeShortfallMs(tokenExpiresAt: number | undefined, deadline: number, now: number) {
  if (typeof tokenExpiresAt !== "number" || !Number.isFinite(tokenExpiresAt)) return undefined
  const shortfall = deadline - tokenExpiresAt
  return shortfall > 0 ? shortfall : undefined
}

/**
 * A production-SHAPED session id: `ses_` + a run-id-like body padded to the
 * length real WorkGraph ids reach. See the header note — a short id here
 * cannot catch the router's silent parameter-length 404.
 */
export function productionLengthSessionId(runId: string) {
  const id = `ses_interactive_smoke_${runId}_${"s".repeat(200)}`
  if (id.length <= 100) throw new Error("Interactive smoke session id must exceed the 100-char router ceiling")
  return id
}

/**
 * Settlement is a CONJUNCTION of history and the active probe, never history
 * alone. Both directions matter, and they are NOT symmetric:
 *
 *   - a terminal step while the harness still owns the drain is mid-turn, not
 *     done (the four-day staging outage: parking on history alone parked every
 *     Run reconciled inside that window);
 *   - a `prompted` with no terminal step and NO active drain is the opposite
 *     failure — the harness took the prompt and stopped without settling. That
 *     is a real deploy defect, so it fails immediately rather than polling out
 *     the six-minute budget and reporting an undiagnosable timeout.
 *
 * The mirror of that logic is `hosted-runtime.ts:598-628`, which parks a Run in
 * exactly this state.
 */
export function classifyTurn(events: readonly SessionEvent[], active: unknown, sessionId: string) {
  const terminal = events.findLast(
    (event) => event.type.startsWith("session.next.step.ended") || event.type.startsWith("session.next.step.failed"),
  )
  if (terminal?.type.startsWith("session.next.step.failed")) {
    return { state: "failed" as const, reason: stepFailureReason(terminal) }
  }
  if (terminal) {
    if (sessionActive(active, sessionId)) {
      return { state: "running" as const, reason: "harness still owns the drain" }
    }
    return { state: "settled" as const, reason: "terminal step and no active drain" }
  }
  // No terminal step. Before the prompt is admitted there is nothing to judge;
  // after it, an idle harness means the turn died silently.
  if (!events.some((event) => event.type.startsWith("session.next.prompted"))) {
    return { state: "running" as const, reason: "prompt not admitted yet" }
  }
  if (sessionActive(active, sessionId)) {
    return { state: "running" as const, reason: "prompted, harness still draining" }
  }
  return {
    state: "failed" as const,
    reason: "the harness stopped after admitting the prompt without settling a step",
  }
}

/**
 * `/api/session/active` answers `{ data: { [sessionID]: ... } }`. Anything
 * unrecognizable is treated as STILL ACTIVE — the safe direction, matching
 * `hostedSessionActive` (hosted-runtime.ts:1694).
 */
function sessionActive(value: unknown, sessionId: string) {
  const data = record(value)?.data
  const map = record(data)
  if (!map) return true
  return sessionId in map
}

/**
 * Which `/connection` responses are worth polling through, and how long to
 * wait before the next one.
 *
 * `provisioning` and a 409 `cloud_runtime_unavailable` are transient — a cold
 * start and a lease that lost a race. Everything else is a DEPLOYMENT fault
 * (402 entitlement, 401/403 auth, 503 no driver) that no amount of polling
 * fixes, so it fails immediately rather than burning the budget.
 *
 * The backoff each carries is the server's own pacing. Note where it lives:
 * `provisioning` puts `retryAfterMs` on the body, while the 409 puts it on the
 * ERROR object — `apiError` spreads its extras flat (workspace-route-support.ts:69),
 * so it is a sibling of `code`, not nested under a `data` envelope. Reading the
 * wrong one silently falls back to the default delay.
 */
export function classifyConnection(status: number, body: unknown) {
  const value = record(body)
  if (status === 200 && value?.status === "provisioning") {
    return { state: "provisioning" as const, retryAfterMs: numberOrUndefined(value.retryAfterMs) }
  }
  const error = record(value?.error)
  if (status === 409 && error?.code === "cloud_runtime_unavailable") {
    return { state: "unavailable" as const, retryAfterMs: numberOrUndefined(error.retryAfterMs) }
  }
  return {
    state: "fatal" as const,
    reason: `${String(error?.code ?? "no_error_code")}: ${String(error?.message ?? JSON.stringify(value ?? null))}`,
  }
}

function numberOrUndefined(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** The assistant's reply text, reassembled from replayable text boundaries. */
export function replyText(events: readonly SessionEvent[]) {
  return events
    .filter((event) => event.type.startsWith("session.next.text.ended"))
    .map((event) => (typeof event.data.text === "string" ? event.data.text : ""))
    .join("\n")
}

export async function interactiveSessionSmoke(env: SmokeEnvironment = process.env, request: typeof fetch = fetch) {
  const startedAt = Date.now()
  const progress = (message: string) =>
    console.log(`[interactive-smoke +${Math.floor((Date.now() - startedAt) / 1_000)}s] ${message}`)
  const deadline = startedAt + SMOKE_DEADLINE_MS
  const base = required(env.BASE_URL, "BASE_URL").replace(/\/+$/, "")
  const clerkSecret = required(env.CLERK_SECRET_KEY, "CLERK_SECRET_KEY")
  const userA = required(env.WORKGRAPH_SMOKE_USER_A_ID, "WORKGRAPH_SMOKE_USER_A_ID")
  const organizationA = required(env.WORKGRAPH_SMOKE_ORGANIZATION_A_ID, "WORKGRAPH_SMOKE_ORGANIZATION_A_ID")
  const repositoryUrl = required(env.WORKGRAPH_SMOKE_REPOSITORY_URL, "WORKGRAPH_SMOKE_REPOSITORY_URL")
  const retryDelayMs = positiveInteger(env.WORKGRAPH_SMOKE_RETRY_DELAY_MS ?? "2000", "WORKGRAPH_SMOKE_RETRY_DELAY_MS")

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const marker = markerToken(runId)
  const sessionId = productionLengthSessionId(runId)

  progress("creating the Clerk smoke Session")
  const clerkSession = await createClerkSession(request, clerkSecret, userA, organizationA)
  let workspaceId: string | undefined
  let connection: Connection | undefined
  try {
    const token = await createClerkSessionToken(request, clerkSecret, clerkSession)
    progress("creating the hosted cloud Workspace")
    const created = record(
      await jsonRequest(request, `${base}/api/workspace/create`, {
        method: "POST",
        headers: { ...authorization(token), "content-type": "application/json" },
        body: JSON.stringify({
          workspaceName: `Interactive session smoke ${runId}`,
          repoUrl: repositoryUrl,
        }),
      }),
    )
    if (typeof created?.workspaceId !== "string" || !created.workspaceId.trim()) {
      throw new Error("Hosted cloud Workspace create returned no workspaceId")
    }
    workspaceId = created.workspaceId
    progress(`created Workspace ${workspaceId}; awaiting a ready sandbox`)

    connection = await waitForReadyConnection(
      request,
      base,
      clerkSecret,
      clerkSession,
      workspaceId,
      Math.min(deadline, Date.now() + PROVISION_BUDGET_MS),
      retryDelayMs,
      progress,
    )
    const shortfallMs = tokenLifetimeShortfallMs(connection.tokenExpiresAt, deadline, Date.now())
    if (shortfallMs !== undefined) {
      // Not fatal — the turn may well finish first — but a 401 partway through
      // the poll loop is otherwise indistinguishable from a broken deploy.
      progress(
        `WARNING: the runtime access token expires ${Math.ceil(shortfallMs / 1_000)}s before this smoke's deadline; `
        + "a 401 mid-poll would be token expiry, not a deploy failure (expected TTL floor is 15 minutes)",
      )
    }
    progress(`sandbox ready on ${connection.relayUrl}; opening interactive Session ${sessionId.length} chars long`)

    const runtime = runtimeRequest(request, connection)
    const createdSession = record(
      await runtimeJson(runtime, "/api/session", {
        method: "POST",
        body: JSON.stringify({
          id: sessionId,
          location: { directory: "/workspace" },
        }),
      }),
    )
    const adoptedId =
      typeof createdSession?.id === "string" ? createdSession.id : record(createdSession?.data)?.id
    if (adoptedId !== sessionId) {
      // A bare bodyless 404 or an id the runtime rewrote both land here. The
      // first is the router's parameter-length refusal (see the header note).
      throw new Error(
        `Interactive Session create did not adopt the requested ${sessionId.length}-char id (got ${String(adoptedId)})`,
      )
    }

    progress(`created Session; prompting for marker ${marker}`)
    await runtimeJson(runtime, `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({
        id: `msg_interactive_smoke_${runId}`,
        prompt: {
          text: [
            `Reply with exactly this one token and nothing else: ${marker}`,
            "Do not use any tools. Do not edit files. Do not explain.",
          ].join("\n"),
        },
        resume: true,
      }),
    })

    const events = await waitForSettledTurn(runtime, sessionId, deadline, retryDelayMs, progress)
    const reply = replyText(events)
    if (!reply.includes(marker)) {
      printHistoryTail(events, progress)
      throw new Error(
        `Interactive hosted turn settled without the marker ${marker} in the reply; reply was ${JSON.stringify(reply.slice(0, 400))}`,
      )
    }
    progress(`interactive hosted turn completed with marker ${marker}`)
    console.log(`Interactive hosted Session smoke passed for Workspace ${workspaceId}`)
  } finally {
    // Every cleanup step is loud but non-fatal. A leaked sandbox is reclaimed
    // by the GC sweep, and throwing from here would replace the assertion the
    // deploy actually gates on with a cleanup error.
    if (connection) {
      // Interrupt, not delete: the Session V2 contract this lane proxies to has
      // no DELETE (packages/protocol/src/groups/session.ts lists every
      // endpoint), and interrupting is what stops a session still draining when
      // an assertion failed mid-turn. The workspace destroy below is what
      // actually reclaims the session along with its VM. Idle interruption is a
      // documented no-op, so this is safe on the passing path too.
      try {
        await runtimeRequest(request, connection)(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
          method: "POST",
        })
      } catch (error) {
        console.warn(`Interactive smoke session interrupt failed: ${errorMessage(error)}`)
      }
    }
    if (workspaceId) {
      try {
        progress(`destroying smoke Workspace ${workspaceId}`)
        const cleanupToken = await createClerkSessionToken(request, clerkSecret, clerkSession)
        await jsonRequest(request, `${base}/api/workspace/${encodeURIComponent(workspaceId)}/lifecycle/destroy`, {
          method: "POST",
          headers: { ...authorization(cleanupToken), "content-type": "application/json" },
          body: JSON.stringify({ approved: true }),
        })
        progress(`destroyed smoke Workspace ${workspaceId}`)
      } catch (error) {
        console.warn(`Interactive smoke Workspace cleanup failed: ${errorMessage(error)}`)
      }
    }
    try {
      await revokeClerkSession(request, clerkSecret, clerkSession)
    } catch (error) {
      console.warn(`Interactive smoke Clerk revoke failed: ${errorMessage(error)}`)
    }
  }
}

/**
 * The app's own provisioning loop: poll `/connection` until the control plane
 * returns a minted runtime access token. `provisioning` carries the server's
 * own `retryAfterMs`, so the poll follows the deployment's pacing rather than
 * inventing one (workspace-hosted-connection-info.ts:116-125).
 */
async function waitForReadyConnection(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  session: Session,
  workspaceId: string,
  deadline: number,
  retryDelayMs: number,
  progress: (message: string) => void,
): Promise<Connection> {
  let cycle = 0
  let lastStatus = "unknown"
  while (Date.now() < deadline) {
    cycle += 1
    const token = await createClerkSessionToken(request, clerkSecret, session)
    const response = await request(`${base}/api/workspace/${encodeURIComponent(workspaceId)}/connection`, {
      headers: authorization(token),
      signal: AbortSignal.timeout(boundedTimeout(deadline)),
    })
    const body = parseJson(await response.text(), `/api/workspace/${workspaceId}/connection`)
    const value = record(body)
    if (response.ok && typeof value?.runtimeAccessToken === "string" && typeof value.relayUrl === "string") {
      progress(`workspace connection ready after ${cycle} polls`)
      return {
        relayUrl: value.relayUrl,
        runtimeAccessToken: value.runtimeAccessToken,
        workspaceId,
        ...(typeof value.tokenExpiresAt === "number" ? { tokenExpiresAt: value.tokenExpiresAt } : {}),
      }
    }
    const verdict = classifyConnection(response.status, value)
    if (verdict.state === "fatal") {
      throw new Error(`Hosted Workspace connection failed: ${response.status} ${verdict.reason}`)
    }
    lastStatus = verdict.state
    if (cycle % 5 === 1) progress(`workspace not ready yet (poll ${cycle}: ${verdict.state})`)
    await wait(Math.min(verdict.retryAfterMs ?? retryDelayMs, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`Hosted Workspace ${workspaceId} never reached a ready sandbox (last status ${lastStatus})`)
}

/**
 * Poll history + the active probe until the turn settles. Both probes are
 * bounded per request; the loop is bounded by the caller's deadline.
 */
async function waitForSettledTurn(
  runtime: RuntimeRequest,
  sessionId: string,
  deadline: number,
  retryDelayMs: number,
  progress: (message: string) => void,
) {
  let cycle = 0
  let lastReason = "not polled"
  while (Date.now() < deadline) {
    cycle += 1
    const events = await sessionHistory(runtime, sessionId, deadline)
    const active = await runtimeJson(runtime, "/api/session/active", {
      signal: AbortSignal.timeout(boundedTimeout(deadline)),
    })
    const verdict = classifyTurn(events, active, sessionId)
    lastReason = verdict.reason
    if (verdict.state === "settled") {
      progress(`turn settled after ${cycle} polls (${verdict.reason})`)
      return events
    }
    if (verdict.state === "failed") {
      printHistoryTail(events, progress)
      throw new Error(`Interactive hosted turn failed: ${verdict.reason}`)
    }
    if (cycle % 5 === 1) progress(`turn still running (poll ${cycle}: ${verdict.reason})`)
    await wait(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())))
  }
  throw new Error(
    `Interactive hosted turn did not settle within ${Math.floor(SMOKE_DEADLINE_MS / 1_000)}s (last probe: ${lastReason})`,
  )
}

/** Paged Session V2 history, same contract the hosted reconciler reads. */
async function sessionHistory(runtime: RuntimeRequest, sessionId: string, deadline: number) {
  const events: SessionEvent[] = []
  let after = 0
  for (;;) {
    const page = historyPage(
      await runtimeJson(runtime, `/api/session/${encodeURIComponent(sessionId)}/history?limit=100&after=${after}`, {
        signal: AbortSignal.timeout(boundedTimeout(deadline)),
      }),
    )
    events.push(...page.data)
    if (!page.hasMore) return events
    const next = page.data.at(-1)?.durable?.seq
    if (next === undefined || next <= after) throw new Error("Session history paging did not advance")
    after = next
  }
}

function historyPage(value: unknown): Readonly<{ data: SessionEvent[]; hasMore: boolean }> {
  const page = record(value)
  if (!page || !Array.isArray(page.data) || typeof page.hasMore !== "boolean") {
    throw new Error("Session history returned an invalid page envelope")
  }
  const data = page.data.map((item) => {
    const event = record(item)
    if (typeof event?.type !== "string" || !record(event.data)) {
      throw new Error("Session history returned an invalid event")
    }
    return event as unknown as SessionEvent
  })
  return { data, hasMore: page.hasMore }
}

function stepFailureReason(event: SessionEvent) {
  const error = event.data.error
  if (typeof error === "string") return error
  const message = record(error)?.message
  return typeof message === "string" ? message : JSON.stringify(error ?? "step failed")
}

/** On failure, the last events are the only diagnosable thing the log carries. */
function printHistoryTail(events: readonly SessionEvent[], progress: (message: string) => void) {
  progress(`session history tail (${events.length} events total):`)
  for (const event of events.slice(-15)) {
    console.log(`  ${event.type} ${JSON.stringify(event.data).slice(0, 300)}`)
  }
}

type RuntimeRequest = (path: string, init?: RequestInit) => Promise<Response>

/**
 * Every runtime call goes THROUGH THE RELAY at
 * `<relayUrl>/workspaces/<workspaceId><path>`, bearing the minted runtime
 * access token — the same shape the app's relay connection builds
 * (workspace-relay-connection.ts:352) and the hosted reconciler uses
 * (hosted-runtime.ts:1406). Anything else would prove the sandbox works while
 * leaving the transport the product depends on untested.
 */
function runtimeRequest(request: typeof fetch, connection: Connection): RuntimeRequest {
  return async (path, init) => {
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${connection.runtimeAccessToken}`)
    headers.set("x-opencode-directory", "/workspace")
    if (init?.body) headers.set("content-type", "application/json")
    const url = `${connection.relayUrl.replace(/\/+$/, "")}/workspaces/${encodeURIComponent(connection.workspaceId)}${path}`
    const response = await request(url, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) return response
    const body = await response.text()
    // A bodyless 404 with no content-type is the engine router refusing the
    // path parameter, NOT an absent session. Naming it here saves the next
    // operator the bisect that cost us a staging incident.
    const routerRefusal =
      response.status === 404 && !body.trim() && !response.headers.get("content-type")
        ? " (bodyless 404 with no content-type — the engine router refused the path parameter; see router-config.ts)"
        : ""
    throw new Error(`Interactive Session request failed: ${init?.method ?? "GET"} ${path} → ${response.status} ${body}${routerRefusal}`)
  }
}

async function runtimeJson(runtime: RuntimeRequest, path: string, init?: RequestInit) {
  const response = await runtime(path, init)
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${path} returned malformed JSON`)
  }
}

// --- Clerk fixture flow. Deliberately duplicated from smoke-workgraph.ts ---
// smoke-workgraph.ts keeps these private and is one self-contained script; it
// is not structured as a shared module, and extracting them would mean editing
// the file that owns the deploy gate this smoke runs beside. The duplication is
// four short functions with no branching, and both call the same documented
// Clerk Backend API. If a third smoke needs them, promote them then.

async function createClerkSession(
  request: typeof fetch,
  secret: string,
  userId: string,
  organizationId: string,
): Promise<Session> {
  const body = await jsonRequest(request, "https://api.clerk.com/v1/sessions", {
    method: "POST",
    headers: clerkHeaders(secret),
    body: JSON.stringify({ user_id: userId, active_organization_id: organizationId }),
  })
  const id = record(body)?.id
  if (typeof id !== "string" || !id.trim()) throw new Error("Clerk session creation returned no Session ID")
  return { id, organizationId }
}

async function createClerkSessionToken(request: typeof fetch, secret: string, session: Session) {
  const body = await jsonRequest(
    request,
    `https://api.clerk.com/v1/sessions/${encodeURIComponent(session.id)}/tokens/convex`,
    {
      method: "POST",
      headers: clerkHeaders(secret),
      body: JSON.stringify({ expires_in_seconds: 900 }),
    },
  )
  const jwt = record(body)?.jwt
  if (typeof jwt !== "string" || !jwt.trim()) throw new Error("Clerk session token creation returned no JWT")
  return jwt
}

async function revokeClerkSession(request: typeof fetch, secret: string, session: Session) {
  await jsonRequest(request, `https://api.clerk.com/v1/sessions/${encodeURIComponent(session.id)}/revoke`, {
    method: "POST",
    headers: clerkHeaders(secret),
  })
}

async function jsonRequest(request: typeof fetch, url: string, init?: RequestInit) {
  const response = await request(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed: ${response.status} ${text}`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${new URL(url).pathname} returned malformed JSON`)
  }
}

function boundedTimeout(deadline: number) {
  return Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()))
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return `${error.name}: ${error.message}`
  return "unknown transport failure"
}

function parseJson(input: string, source: string) {
  try {
    return JSON.parse(input) as unknown
  } catch {
    throw new Error(`${source} returned malformed JSON`)
  }
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function required(value: string | undefined, name: string) {
  const cleaned = value?.trim()
  if (!cleaned) throw new Error(`${name} is required`)
  return cleaned
}

function positiveInteger(value: string, name: string) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function authorization(token: string) {
  return { authorization: `Bearer ${token}` }
}

function clerkHeaders(secret: string) {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" }
}

if (import.meta.main) await interactiveSessionSmoke()
