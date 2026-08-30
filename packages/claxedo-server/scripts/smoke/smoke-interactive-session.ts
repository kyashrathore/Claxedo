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
 *   3. open a harness-neutral Session on the workspace runtime THROUGH THE RELAY,
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
 * Settlement comes from the shared Session projection itself: `status` says
 * whether a harness owns an active turn and `lastTurn` is the persisted,
 * harness-neutral terminal outcome. The transcript is read from the same
 * runtime's message snapshot. No engine-specific history or active probe is
 * part of this path.
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
 * minutes (`authority/runtime-access-token.ts:51`), so a single token
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

/** Classify the shared runtime's persisted, harness-neutral Session state. */
export function classifyTurn(session: unknown) {
  const value = record(session)
  const status = value?.status
  if (status === "busy" || status === "recovering" || status === "retry") {
    return { state: "running" as const, reason: `session status is ${status}` }
  }
  const lastTurn = record(value?.lastTurn)
  if (lastTurn?.status === "failed") {
    return { state: "failed" as const, reason: typeof lastTurn.error === "string" ? lastTurn.error : "Session failed" }
  }
  if (lastTurn?.status === "cancelled") {
    return { state: "failed" as const, reason: typeof lastTurn.reason === "string" ? lastTurn.reason : "Session was cancelled" }
  }
  if (lastTurn?.status === "completed") {
    return { state: "settled" as const, reason: "persisted terminal turn" }
  }
  return { state: "running" as const, reason: "no persisted terminal turn yet" }
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

/** The assistant's reply text, reassembled from the canonical transcript. */
export function replyText(messages: readonly unknown[]) {
  const assistant = messages.findLast((message) => record(record(message)?.info)?.role === "assistant")
  const parts = record(assistant)?.parts
  if (!Array.isArray(parts)) return ""
  return parts.flatMap((part) => {
    const value = record(part)
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : []
  }).join("\n")
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
  const agent = required(env.WORKGRAPH_SMOKE_AGENT, "WORKGRAPH_SMOKE_AGENT")
  const providerID = required(env.WORKGRAPH_SMOKE_PROVIDER_ID, "WORKGRAPH_SMOKE_PROVIDER_ID")
  const modelID = required(env.WORKGRAPH_SMOKE_MODEL_ID, "WORKGRAPH_SMOKE_MODEL_ID")
  const variant = required(env.WORKGRAPH_SMOKE_EFFORT, "WORKGRAPH_SMOKE_EFFORT")
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
      await runtimeJson(runtime, "/session?harness=opencode", {
        method: "POST",
        body: JSON.stringify({
          id: sessionId,
          agent,
          model: { providerID, modelID },
          variant,
        }),
      }),
    )
    const adoptedId = createdSession?.id
    if (adoptedId !== sessionId) {
      // A bare bodyless 404 or an id the runtime rewrote both land here. The
      // first is the router's parameter-length refusal (see the header note).
      throw new Error(
        `Interactive Session create did not adopt the requested ${sessionId.length}-char id (got ${String(adoptedId)})`,
      )
    }

    progress(`created Session; prompting for marker ${marker}`)
    await runtimeJson(runtime, `/session/${encodeURIComponent(sessionId)}/prompt_async?harness=opencode`, {
      method: "POST",
      body: JSON.stringify({
        messageID: `msg_interactive_smoke_${runId}`,
        parts: [{
          type: "text",
          text: [
            `Reply with exactly this one token and nothing else: ${marker}`,
            "Do not use any tools. Do not edit files. Do not explain.",
          ].join("\n"),
        }],
        agent,
        model: { providerID, modelID },
        variant,
      }),
    })

    const messages = await waitForSettledTurn(runtime, sessionId, deadline, retryDelayMs, progress)
    const reply = replyText(messages)
    if (!reply.includes(marker)) {
      printTranscriptTail(messages, progress)
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
      // Abort, not delete: aborting is what stops a Session still draining when
      // an assertion failed mid-turn. The workspace destroy below is what
      // actually reclaims the session along with its VM. Idle interruption is a
      // documented no-op, so this is safe on the passing path too.
      try {
        await runtimeRequest(request, connection)(`/session/${encodeURIComponent(sessionId)}/abort`, {
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
        // Teardown has TWO layers and destroy is only the first: it reclaims
        // the sandbox VM, while the Convex workspace ROW survives — correct for
        // a real user's project awaiting its next wake, but for a smoke that is
        // done forever it left one "Interactive session smoke …" corpse in the
        // app's project inventory per deploy (and a per-project /documents 404
        // on every index load). DELETE /api/workspace/:id is the row
        // soft-delete.
        await jsonRequest(request, `${base}/api/workspace/${encodeURIComponent(workspaceId)}?access=cloud`, {
          method: "DELETE",
          headers: authorization(cleanupToken),
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
 * Poll the shared Session projection until its persisted turn outcome settles.
 * The transcript snapshot is returned from the same journal boundary.
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
    const encoded = encodeURIComponent(sessionId)
    const [session, snapshot] = await Promise.all([
      runtimeJson(runtime, `/session/${encoded}`, {
        signal: AbortSignal.timeout(boundedTimeout(deadline)),
      }),
      runtimeJson(runtime, `/session/${encoded}/message?snapshot=1`, {
        signal: AbortSignal.timeout(boundedTimeout(deadline)),
      }),
    ])
    const messages = transcriptMessages(snapshot)
    const verdict = classifyTurn(session)
    lastReason = verdict.reason
    if (verdict.state === "settled") {
      progress(`turn settled after ${cycle} polls (${verdict.reason})`)
      return messages
    }
    if (verdict.state === "failed") {
      printTranscriptTail(messages, progress)
      throw new Error(`Interactive hosted turn failed: ${verdict.reason}`)
    }
    if (cycle % 5 === 1) progress(`turn still running (poll ${cycle}: ${verdict.reason})`)
    await wait(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())))
  }
  throw new Error(
    `Interactive hosted turn did not settle within ${Math.floor(SMOKE_DEADLINE_MS / 1_000)}s (last probe: ${lastReason})`,
  )
}

function transcriptMessages(value: unknown) {
  const messages = record(value)?.messages
  if (!Array.isArray(messages)) throw new Error("Session transcript snapshot returned an invalid envelope")
  return messages
}

/** On failure, the last messages are the only diagnosable thing the log carries. */
function printTranscriptTail(messages: readonly unknown[], progress: (message: string) => void) {
  progress(`session transcript tail (${messages.length} messages total):`)
  for (const message of messages.slice(-10)) {
    console.log(`  ${JSON.stringify(message).slice(0, 500)}`)
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
    throw new Error(`Interactive Session request failed: ${init?.method ?? "GET"} ${path} → ${response.status} ${body}`)
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
