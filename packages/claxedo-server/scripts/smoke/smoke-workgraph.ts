type SmokeEnvironment = Readonly<Record<string, string | undefined>>

type Session = Readonly<{ id: string; organizationId: string }>

type SmokeStream = Readonly<{
  streamId: string
  session: Session
  deleteOperationId: string
  reason: string
}>

export function classifyAttemptPlacement(state: string) {
  if (["placing", "running", "result"].includes(state)) return "started" as const
  if (state === "admitted") return "pending" as const
  throw new Error(`Hosted Attempt reached ${state} before placement start was observed`)
}

export async function workGraphSmoke(env: SmokeEnvironment = process.env, request: typeof fetch = fetch) {
  const startedAt = Date.now()
  const progress = (message: string) =>
    console.log(`[workgraph-smoke +${Math.floor((Date.now() - startedAt) / 1_000)}s] ${message}`)
  const base = required(env.BASE_URL, "BASE_URL").replace(/\/+$/, "")
  const clerkSecret = required(env.CLERK_SECRET_KEY, "CLERK_SECRET_KEY")
  const userA = required(env.WORKGRAPH_SMOKE_USER_A_ID, "WORKGRAPH_SMOKE_USER_A_ID")
  const userB = required(env.WORKGRAPH_SMOKE_USER_B_ID, "WORKGRAPH_SMOKE_USER_B_ID")
  const organizationA = required(env.WORKGRAPH_SMOKE_ORGANIZATION_A_ID, "WORKGRAPH_SMOKE_ORGANIZATION_A_ID")
  const organizationB = required(env.WORKGRAPH_SMOKE_ORGANIZATION_B_ID, "WORKGRAPH_SMOKE_ORGANIZATION_B_ID")
  const reconcileToken = required(env.WORKGRAPH_SMOKE_RECONCILE_TOKEN, "WORKGRAPH_SMOKE_RECONCILE_TOKEN")
  const retryDelayMs = positiveInteger(env.WORKGRAPH_SMOKE_RETRY_DELAY_MS ?? "2000", "WORKGRAPH_SMOKE_RETRY_DELAY_MS")
  if (userA === userB) throw new Error("WorkGraph smoke identities must be different users")
  if (organizationA === organizationB) throw new Error("WorkGraph smoke identities must use different organizations")

  progress("probing fail-closed WorkGraph authentication")
  const garbage = await request(`${base}/api/workgraph/snapshot?limit=1`, {
    headers: { authorization: `Bearer workgraph-smoke-invalid-${Date.now()}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (garbage.status !== 401) throw new Error(`WorkGraph fail-closed probe expected 401, got ${garbage.status}`)

  progress("creating Clerk smoke Sessions")
  const sessionAOrganizationA = await createClerkSession(request, clerkSecret, userA, organizationA)
  const sessionAOrganizationB = await createClerkSession(request, clerkSecret, userA, organizationB).catch(
    async (error) => {
      await revokeClerkSession(request, clerkSecret, sessionAOrganizationA)
      throw error
    },
  )
  const sessionBOrganizationA = await createClerkSession(request, clerkSecret, userB, organizationA).catch(
    async (error) => {
      await Promise.all(
        [sessionAOrganizationA, sessionAOrganizationB].map((session) =>
          revokeClerkSession(request, clerkSecret, session),
        ),
      )
      throw error
    },
  )
  const sessions = [sessionAOrganizationA, sessionAOrganizationB, sessionBOrganizationA]
  try {
    progress("refreshing hosted execution capabilities")
    await refreshExecutionCapabilities(request, base, clerkSecret, sessionAOrganizationA, retryDelayMs)
    progress("reading hosted execution capabilities")
    const capabilities = await readExecutionCapabilities(
      request,
      base,
      clerkSecret,
      sessionAOrganizationA,
      retryDelayMs,
    )
    const execution = requireExecutionProfile(capabilities, env)

    progress("creating the authenticated Stream")
    const tokenA = await createClerkSessionToken(request, clerkSecret, sessionAOrganizationA)
    progress("probing the hosted Documents backend")
    const documentsProbe = await request(`${base}/documents/__claxedo_deployment_probe__`, {
      headers: authorization(tokenA),
      signal: AbortSignal.timeout(15_000),
    })
    if (documentsProbe.status !== 404) {
      throw new Error(`Documents backend probe expected 404, got ${documentsProbe.status}: ${await documentsProbe.text()}`)
    }
    const operationId = `smoke_${Date.now()}`
    const streamId = commandValue(
      await command(request, base, tokenA, operationId, {
        version: 1,
        type: "create_stream",
        title: `Hosted smoke ${operationId}`,
        execution,
      }),
      "streamId",
    )
    const cleanupStreams = new Map<string, SmokeStream>([
      [
        streamId,
        {
          streamId,
          session: sessionAOrganizationA,
          deleteOperationId: `${operationId}_cleanup`,
          reason: "Hosted deployment smoke cleanup",
        },
      ],
    ])
    let executionError: unknown
    try {
      progress(`created Stream ${streamId}; creating its Task`)
      const workItemId = commandValue(
        await command(request, base, tokenA, `${operationId}_task`, {
          version: 1,
          type: "create_work_item",
          streamId,
          title: "Confirm the hosted WorkGraph no-op execution path",
          completionContract: {
            version: 1,
            mode: "all",
            requirements: [
              {
                id: "hosted_smoke",
                kind: "verification",
                description: "The signed Cloud composition returns a durable result without changing the workspace",
                instructions: "Do not edit files or use workspace tools. Complete through the required WorkGraph completion tool with verification evidence.",
              },
            ],
          },
        }),
        "workItemId",
      )

      const [stream, task, snapshot, cursorPage] = await Promise.all([
        jsonRequest(request, `${base}/api/workgraph/streams/${encodeURIComponent(streamId)}`, {
          headers: authorization(tokenA),
        }),
        jsonRequest(request, `${base}/api/workgraph/work-items/${encodeURIComponent(workItemId)}`, {
          headers: authorization(tokenA),
        }),
        jsonRequest(request, `${base}/api/workgraph/snapshot?limit=100`, { headers: authorization(tokenA) }),
        jsonRequest(request, `${base}/api/workgraph/snapshot?limit=1`, { headers: authorization(tokenA) }),
      ])
      requireRecord(stream, streamId, "Stream")
      requireRecord(task, workItemId, "Task")
      if (
        !records(snapshot).some((record) => record.id === streamId) ||
        !records(snapshot).some((record) => record.id === workItemId)
      ) {
        throw new Error("Created Stream and Task are absent from the authenticated Convex snapshot")
      }

      progress(`created Task ${workItemId}; verifying tenant isolation`)
      const cursor = snapshotCursor(cursorPage)
      await assertTenantIsolation(
        request,
        base,
        await createClerkSessionToken(request, clerkSecret, sessionAOrganizationB),
        "same user in another organization",
        streamId,
        workItemId,
        cursor,
        `${operationId}_cross_org`,
      )
      await assertTenantIsolation(
        request,
        base,
        await createClerkSessionToken(request, clerkSecret, sessionBOrganizationA),
        "another user in the same organization",
        streamId,
        workItemId,
        cursor,
        `${operationId}_cross_user`,
      )

      requireRecord(
        await jsonRequest(request, `${base}/api/workgraph/streams/${encodeURIComponent(streamId)}`, {
          headers: authorization(tokenA),
        }),
        streamId,
        "Stream after tenant-isolation probes",
      )

      progress("proving bare Stream control-effect settlement")
      const bareStream = await createBareStream(
        request,
        base,
        tokenA,
        `${operationId}_bare`,
        `Hosted bare settlement smoke ${operationId}`,
        sessionAOrganizationA,
      )
      cleanupStreams.set(bareStream.streamId, bareStream)
      await deleteStreamWithinBudget(request, base, tokenA, bareStream, retryDelayMs, progress)
      cleanupStreams.delete(bareStream.streamId)

      progress("creating tenant B Stream for isolated settlement proof")
      const tokenB = await createClerkSessionToken(request, clerkSecret, sessionBOrganizationA)
      const tenantBStream = await createBareStream(
        request,
        base,
        tokenB,
        `${operationId}_tenant_b`,
        `Hosted tenant B settlement smoke ${operationId}`,
        sessionBOrganizationA,
      )
      cleanupStreams.set(tenantBStream.streamId, tenantBStream)

      progress("tenant isolation passed; awaiting continuous-execution admission")
      // Execution modes are gone: a user-created Task is born `pending` (approved),
      // and the active Stream's continuous drain — nudged by every command's hosted
      // settlement dispatcher and re-derived on the CF cron — admits it with no
      // execute command. Discover the drained Attempt, then hold the same placement
      // SLA and reconcile polling as before.
      const executeStartedAt = Date.now()
      const attemptId = await waitForAdmittedAttempt(
        request,
        base,
        tokenA,
        workItemId,
        executeStartedAt,
        retryDelayMs,
        progress,
      )
      const fastPathResults = await Promise.allSettled([
        waitForAttemptPlacement(
          request,
          base,
          tokenA,
          attemptId,
          executeStartedAt,
          retryDelayMs,
          progress,
        ),
        deleteStreamWithinBudget(request, base, tokenB, tenantBStream, retryDelayMs, progress),
      ])
      if (fastPathResults[1]!.status === "fulfilled") cleanupStreams.delete(tenantBStream.streamId)
      const fastPathFailure = fastPathResults.find((result) => result.status === "rejected")
      if (fastPathFailure?.status === "rejected") throw fastPathFailure.reason
      progress(`created Attempt ${attemptId}; reconciling execution`)
      const references = await reconcileAttempt(
        request,
        base,
        clerkSecret,
        sessionAOrganizationA,
        reconcileToken,
        attemptId,
        progress,
      )
      progress(`verifying retained Session ${references.sessionId} in Workspace ${references.workspaceId}`)
      await verifyHostedSession(request, base, tokenA, references)
      console.log(`WorkGraph hosted signed user-and-organization isolation and execution passed for ${streamId}`)
    } catch (error) {
      executionError = error
      throw error
    } finally {
      const cleanupErrors: unknown[] = []
      for (const cleanup of cleanupStreams.values()) {
        try {
          await cleanupStream(
            request,
            base,
            clerkSecret,
            reconcileToken,
            cleanup,
            progress,
          )
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
          console.warn(`Hosted deployment smoke cleanup also failed: ${errorMessage(cleanupError)}`)
        }
      }
      if (!executionError && cleanupErrors.length > 0) throw cleanupErrors[0]
    }
  } finally {
    progress("revoking Clerk smoke Sessions")
    await Promise.all(sessions.map((session) => revokeClerkSession(request, clerkSecret, session)))
    progress("revoked Clerk smoke Sessions")
  }
}

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
  const claims = jwtClaims(jwt)
  const audience = claims.aud
  const organizationId = claims.org_id ?? record(claims.o)?.id
  if (audience !== "convex" && (!Array.isArray(audience) || !audience.includes("convex"))) {
    throw new Error("Clerk convex JWT template must include the convex audience")
  }
  if (organizationId !== session.organizationId) {
    throw new Error("Clerk convex JWT template must include the active organization as org_id")
  }
  return jwt
}

function jwtClaims(token: string) {
  const encoded = token.split(".")[1]
  if (!encoded) throw new Error("Clerk session token creation returned a malformed JWT")
  try {
    return record(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))) ?? {}
  } catch {
    throw new Error("Clerk session token creation returned a malformed JWT")
  }
}

async function revokeClerkSession(request: typeof fetch, secret: string, session: Session) {
  await jsonRequest(request, `https://api.clerk.com/v1/sessions/${encodeURIComponent(session.id)}/revoke`, {
    method: "POST",
    headers: clerkHeaders(secret),
  })
}

async function command(
  request: typeof fetch,
  base: string,
  token: string,
  operationId: string,
  body: Record<string, unknown>,
) {
  const result = await jsonRequest(request, `${base}/api/workgraph/commands`, {
    method: "POST",
    headers: { ...authorization(token), "content-type": "application/json" },
    body: JSON.stringify({ operationId, command: body }),
  })
  const parsed = record(result)
  if (parsed?.ok !== true || !record(parsed.value)) {
    throw new Error(`WorkGraph command ${operationId} returned an invalid success envelope`)
  }
  return parsed.value as Record<string, unknown>
}

async function assertTenantIsolation(
  request: typeof fetch,
  base: string,
  token: string,
  boundary: string,
  streamId: string,
  workItemId: string,
  cursor: string,
  operationId: string,
) {
  const snapshot = await jsonRequest(request, `${base}/api/workgraph/snapshot?limit=100`, {
    headers: authorization(token),
  })
  if (records(snapshot).some((item) => item.id === streamId || item.id === workItemId)) {
    throw new Error(`${boundary} observed the source tenant's WorkGraph records`)
  }

  await Promise.all([
    expectNotFound(
      request,
      `${base}/api/workgraph/streams/${encodeURIComponent(streamId)}`,
      { headers: authorization(token) },
      `${boundary} guessed Stream read`,
    ),
    expectNotFound(
      request,
      `${base}/api/workgraph/work-items/${encodeURIComponent(workItemId)}`,
      { headers: authorization(token) },
      `${boundary} guessed Task read`,
    ),
  ])

  await expectNotFound(
    request,
    `${base}/api/workgraph/commands`,
    {
      method: "POST",
      headers: { ...authorization(token), "content-type": "application/json" },
      body: JSON.stringify({
        operationId,
        command: {
          version: 1,
          type: "update_stream",
          streamId,
          expectedVersion: 1,
          title: "Tenant isolation mutation probe",
        },
      }),
    },
    `${boundary} guessed Stream mutation`,
  )

  const cursorResponse = await request(`${base}/api/workgraph/snapshot?after=${encodeURIComponent(cursor)}&limit=1`, {
    headers: authorization(token),
    signal: AbortSignal.timeout(15_000),
  })
  const cursorBody = parseJson(await cursorResponse.text(), "/api/workgraph/snapshot cross-tenant cursor")
  if (cursorResponse.status !== 409 || record(record(cursorBody)?.error)?.code !== "cursor_invalid") {
    throw new Error(
      `${boundary} cursor isolation expected 409/cursor_invalid, got ${cursorResponse.status}/${String(record(record(cursorBody)?.error)?.code ?? "missing_error_code")}`,
    )
  }
}

async function expectNotFound(request: typeof fetch, url: string, init: RequestInit, probe: string) {
  const response = await request(url, { ...init, signal: AbortSignal.timeout(15_000) })
  const body = parseJson(await response.text(), new URL(url).pathname)
  if (response.status !== 404 || record(record(body)?.error)?.code !== "not_found") {
    throw new Error(`${probe} expected an indistinguishable not_found response, got ${response.status}`)
  }
}

async function jsonRequest(request: typeof fetch, url: string, init?: RequestInit) {
  const response = await request(url, { ...init, signal: AbortSignal.timeout(15_000) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${new URL(url).pathname} failed: ${response.status} ${text}`)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${new URL(url).pathname} returned malformed JSON`)
  }
}

async function readExecutionCapabilities(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  session: Session,
  retryDelayMs: number,
) {
  const deadline = Date.now() + 120_000
  let lastError: ReturnType<typeof executionCapabilitiesError> | undefined
  let lastTransportError: string | undefined
  while (Date.now() < deadline) {
    const response = await request(`${base}/api/workgraph/execution-capabilities`, {
      headers: authorization(await createClerkSessionToken(request, clerkSecret, session)),
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
    }).catch((error: unknown) => {
      lastTransportError = errorMessage(error)
      console.warn(`Execution capability read transport retry: ${lastTransportError}`)
      return undefined
    })
    if (!response) {
      await wait(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())))
      continue
    }
    const body = parseJson(await response.text(), "/api/workgraph/execution-capabilities")
    if (response.ok) {
      requireHostedCapabilities(body)
      return body
    }
    const error = executionCapabilitiesError(body, response.status)
    lastError = error
    console.warn(`Execution capability read retry: ${error.capability}/${error.reason}: ${error.message}`)
    if (!error.retryable) {
      throw new Error(`Execution capability ${error.capability}/${error.reason} is unavailable: ${error.message}`)
    }
    await wait(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())))
  }
  throw new Error(
    `Execution capability route remained retryable-unavailable for two minutes${lastError ? `: ${lastError.capability}/${lastError.reason}: ${lastError.message}` : lastTransportError ? `: ${lastTransportError}` : ""}`,
  )
}

async function refreshExecutionCapabilities(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  session: Session,
  retryDelayMs: number,
) {
  const deadline = Date.now() + 120_000
  let lastError: ReturnType<typeof executionCapabilitiesError> | undefined
  let lastTransportError: string | undefined
  while (Date.now() < deadline) {
    const response = await request(`${base}/api/workgraph/execution-capabilities/refresh`, {
      method: "POST",
      headers: authorization(await createClerkSessionToken(request, clerkSecret, session)),
      signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, deadline - Date.now()))),
    }).catch((error: unknown) => {
      lastTransportError = errorMessage(error)
      console.warn(`Execution capability refresh transport retry: ${lastTransportError}`)
      return undefined
    })
    if (!response) {
      await wait(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())))
      continue
    }
    const body = parseJson(await response.text(), "/api/workgraph/execution-capabilities/refresh")
    if (response.ok) return
    const error = executionCapabilitiesError(body, response.status)
    lastError = error
    console.warn(`Execution capability refresh retry: ${error.capability}/${error.reason}: ${error.message}`)
    if (!error.retryable) {
      throw new Error(`Execution capability ${error.capability}/${error.reason} is unavailable: ${error.message}`)
    }
    await wait(Math.min(retryDelayMs, Math.max(0, deadline - Date.now())))
  }
  throw new Error(
    `Execution capability refresh remained retryable-unavailable for two minutes${lastError ? `: ${lastError.capability}/${lastError.reason}: ${lastError.message}` : lastTransportError ? `: ${lastTransportError}` : ""}`,
  )
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return `${error.name}: ${error.message}`
  return "unknown transport failure"
}

function executionCapabilitiesError(input: unknown, status: number) {
  const error = record(record(input)?.error)
  if (
    status !== 503 ||
    error?.code !== "execution_capabilities_unavailable" ||
    typeof error.capability !== "string" ||
    typeof error.reason !== "string" ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean"
  ) {
    throw new Error(`Execution capability route returned an invalid ${status} error envelope`)
  }
  return error as Record<string, unknown> & {
    capability: string
    reason: string
    message: string
    retryable: boolean
  }
}

function requireHostedCapabilities(input: unknown) {
  const value = record(input)
  if (value?.schemaVersion !== 1 || typeof value.ownerUserId !== "string") {
    throw new Error("WorkGraph execution capability route returned an invalid owner envelope")
  }
  const environments = Array.isArray(value.environments) ? value.environments : []
  if (!environments.some((environment) => record(environment)?.kind === "hosted_workspace")) {
    throw new Error("WorkGraph execution capability route did not advertise the hosted Workspace environment")
  }
}

function requireExecutionProfile(input: unknown, env: SmokeEnvironment) {
  const value = record(input)!
  const harness = required(env.WORKGRAPH_SMOKE_HARNESS, "WORKGRAPH_SMOKE_HARNESS")
  const agent = required(env.WORKGRAPH_SMOKE_AGENT, "WORKGRAPH_SMOKE_AGENT")
  const providerId = required(env.WORKGRAPH_SMOKE_PROVIDER_ID, "WORKGRAPH_SMOKE_PROVIDER_ID")
  const modelId = required(env.WORKGRAPH_SMOKE_MODEL_ID, "WORKGRAPH_SMOKE_MODEL_ID")
  const effort = required(env.WORKGRAPH_SMOKE_EFFORT, "WORKGRAPH_SMOKE_EFFORT")
  const repositoryUrl = required(env.WORKGRAPH_SMOKE_REPOSITORY_URL, "WORKGRAPH_SMOKE_REPOSITORY_URL")
  const baseRevision = required(env.WORKGRAPH_SMOKE_BASE_REVISION, "WORKGRAPH_SMOKE_BASE_REVISION")
  const tools = stringArray(
    required(env.WORKGRAPH_SMOKE_TOOLS_JSON, "WORKGRAPH_SMOKE_TOOLS_JSON"),
    "WORKGRAPH_SMOKE_TOOLS_JSON",
  )
  const environment = array(value.environments)
    .map(record)
    .find((item) => item?.kind === "hosted_workspace")
  if (environment?.remoteUrlInput !== true || environment.baseRevisionInput !== true) {
    throw new Error("Hosted execution capabilities do not accept the smoke repository target")
  }
  if (
    !array(value.harnesses)
      .map(record)
      .some((item) => item?.id === harness)
  ) {
    throw new Error(`Configured smoke harness ${harness} is absent from execution capabilities`)
  }
  if (
    !array(value.agents)
      .map(record)
      .some((item) => item?.id === agent && item.harnessId === harness)
  ) {
    throw new Error(`Configured smoke Agent ${agent} is unavailable for harness ${harness}`)
  }
  const model = array(value.models)
    .map(record)
    .find((item) => item?.harnessId === harness && item.providerId === providerId && item.modelId === modelId)
  if (!model || !array(model.efforts).includes(effort)) {
    throw new Error(`Configured smoke model ${providerId}/${modelId} effort ${effort} is unavailable`)
  }
  const availableTools = new Set(
    array(value.tools)
      .map(record)
      .filter((item) => item?.harnessId === harness)
      .map((item) => item!.id),
  )
  if (tools.some((tool) => !availableTools.has(tool))) {
    throw new Error("Configured smoke tools include a tool absent from execution capabilities")
  }
  return {
    environment: { kind: "hosted_workspace" as const, repositoryUrl },
    repository: { remoteUrl: repositoryUrl, baseRevision },
    harness,
    agent,
    model: { providerId, modelId },
    effort,
    tools,
    connectionIds: [],
  }
}

async function createBareStream(
  request: typeof fetch,
  base: string,
  token: string,
  operationId: string,
  title: string,
  session: Session,
): Promise<SmokeStream> {
  return {
    streamId: commandValue(
      await command(request, base, token, operationId, {
        version: 1,
        type: "create_stream",
        title,
      }),
      "streamId",
    ),
    session,
    deleteOperationId: `${operationId}_delete`,
    reason: "Hosted fast-lane settlement smoke cleanup",
  }
}

async function waitForAdmittedAttempt(
  request: typeof fetch,
  base: string,
  token: string,
  workItemId: string,
  startedAt: number,
  retryDelayMs: number,
  progress: (message: string) => void,
) {
  const deadline = startedAt + 10_000
  while (Date.now() < deadline) {
    const snapshot = await jsonRequest(request, `${base}/api/workgraph/snapshot?limit=200`, {
      headers: authorization(token),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    const attempt = records(snapshot).find(
      (row) => row.recordType === "attempt" && row.workItemId === workItemId && typeof row.id === "string",
    )
    if (attempt && typeof attempt.id === "string") {
      const latencyMs = Date.now() - startedAt
      progress(`continuous drain admitted Attempt ${attempt.id} for Task ${workItemId} after ${latencyMs}ms`)
      return attempt.id
    }
    await wait(Math.min(retryDelayMs, 500, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`Continuous execution did not admit an Attempt for Task ${workItemId} within <10000ms`)
}

async function waitForAttemptPlacement(
  request: typeof fetch,
  base: string,
  token: string,
  attemptId: string,
  startedAt: number,
  retryDelayMs: number,
  progress: (message: string) => void,
) {
  const deadline = startedAt + 10_000
  while (Date.now() < deadline) {
    const response = await request(`${base}/api/workgraph/attempts/${encodeURIComponent(attemptId)}`, {
      headers: authorization(token),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    const body = parseJson(await response.text(), "/api/workgraph/attempts placement latency")
    if (!response.ok) throw new Error(`Hosted Attempt placement verification failed: ${response.status}`)
    const attempt = record(record(body)?.attempt)
    if (attempt?.id !== attemptId || typeof attempt.state !== "string") {
      throw new Error("Hosted Attempt detail returned an invalid envelope")
    }
    if (classifyAttemptPlacement(attempt.state) === "started") {
      const latencyMs = Date.now() - startedAt
      if (latencyMs >= 10_000) throw new Error(`Hosted Attempt placement started after ${latencyMs}ms; budget is <10000ms`)
      progress(`Attempt ${attemptId} placement reached ${attempt.state} after ${latencyMs}ms without manual reconciliation`)
      return
    }
    await wait(Math.min(retryDelayMs, 500, Math.max(0, deadline - Date.now())))
  }
  throw new Error("Hosted Attempt placement did not start within <10000ms without manual reconciliation")
}

async function deleteStreamWithinBudget(
  request: typeof fetch,
  base: string,
  token: string,
  stream: SmokeStream,
  retryDelayMs: number,
  progress: (message: string) => void,
) {
  const startedAt = Date.now()
  await command(request, base, token, stream.deleteOperationId, {
    version: 1,
    type: "delete_stream",
    streamId: stream.streamId,
    expectedVersion: 1,
    reason: stream.reason,
  })
  const deadline = startedAt + 20_000
  while (Date.now() < deadline) {
    const response = await request(`${base}/api/workgraph/streams/${encodeURIComponent(stream.streamId)}`, {
      headers: authorization(token),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    if (response.status === 404) {
      const latencyMs = Date.now() - startedAt
      if (latencyMs >= 20_000) throw new Error(`Hosted Stream deletion settled after ${latencyMs}ms; budget is <20000ms`)
      progress(`Stream ${stream.streamId} control effect settled after ${latencyMs}ms without manual reconciliation`)
      return
    }
    if (!response.ok) {
      throw new Error(`Hosted Stream deletion verification failed: ${response.status} ${await response.text()}`)
    }
    await wait(Math.min(retryDelayMs, 500, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`Hosted Stream ${stream.streamId} control effect did not settle within <20000ms without manual reconciliation`)
}

async function reconcileAttempt(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  session: Session,
  reconcileToken: string,
  attemptId: string,
  progress: (message: string) => void,
) {
  const deadline = Date.now() + 6 * 60_000
  let cycle = 0
  while (Date.now() < deadline) {
    cycle += 1
    progress(`reconciling Attempt ${attemptId} (cycle ${cycle})`)
    try {
      await triggerReconciliation(request, base, reconcileToken, Math.max(1, deadline - Date.now()))
    } catch (error) {
      if (Date.now() >= deadline) break
      throw error
    }
    const detail = record(
      await jsonRequest(request, `${base}/api/workgraph/attempts/${encodeURIComponent(attemptId)}`, {
        headers: authorization(await createClerkSessionToken(request, clerkSecret, session)),
      }),
    )
    const attempt = record(detail?.attempt)
    if (attempt?.id !== attemptId || typeof attempt.state !== "string") {
      throw new Error("Hosted Attempt detail returned an invalid envelope")
    }
    progress(`Attempt ${attemptId} is ${attempt.state}`)
    if (attempt.state === "result") {
      const references = record(detail?.executionReferences)
      if (typeof references?.workspaceId !== "string" || typeof references.sessionId !== "string") {
        throw new Error("Hosted Attempt result has no durable Workspace and Session references")
      }
      return { workspaceId: references.workspaceId, sessionId: references.sessionId }
    }
    if (attempt.state === "attention" || attempt.state === "failed" || attempt.state === "cancelled") {
      const reason = typeof attempt.attentionReason === "string" ? `: ${attempt.attentionReason}` : ""
      throw new Error(`Hosted Attempt reached ${attempt.state} instead of a result${reason}`)
    }
    await wait(Math.min(12_000, Math.max(0, deadline - Date.now())))
  }
  throw new Error("Hosted Attempt did not produce a result within six minutes")
}

async function verifyHostedSession(
  request: typeof fetch,
  base: string,
  token: string,
  references: { workspaceId: string; sessionId: string },
) {
  const [gateway, inventory, transcript] = await Promise.all([
    jsonRequest(request, `${base}/api/control/sessions/${encodeURIComponent(references.sessionId)}/gateway`, {
      headers: authorization(token),
    }),
    jsonRequest(request, `${base}/api/control/sessions?workspaceId=${encodeURIComponent(references.workspaceId)}`, {
      headers: authorization(token),
    }),
    jsonRequest(
      request,
      `${base}/api/control/sessions/${encodeURIComponent(references.sessionId)}/messages?workspaceId=${encodeURIComponent(references.workspaceId)}`,
      { headers: authorization(token) },
    ),
  ])
  const resolved = record(gateway)
  if (
    resolved?.workspaceId !== references.workspaceId ||
    resolved.harnessHost !== "central" ||
    resolved.gatewayUrl !== null
  ) {
    throw new Error("Hosted Session gateway did not resolve the owning Workspace")
  }
  const sessions = array(record(inventory)?.sessions).map(record)
  if (!sessions.some((session) => session?.session_id === references.sessionId)) {
    throw new Error("Hosted Session is absent from the owning Workspace inventory")
  }
  const messages = array(record(transcript)?.messages).map(record)
  if (record(transcript)?.allowed !== true || messages.length < 2) {
    throw new Error("Hosted Session transcript was not retained")
  }
  const roles = new Set(messages.map((message) => record(message?.info)?.role))
  if (!roles.has("user") || !roles.has("assistant")) {
    throw new Error("Hosted Session transcript does not contain both user and assistant messages")
  }
}

async function reconcileDeletion(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  session: Session,
  reconcileToken: string,
  streamId: string,
  progress: (message: string) => void,
) {
  const deadline = Date.now() + 2 * 60_000
  let cycle = 0
  while (Date.now() < deadline) {
    cycle += 1
    progress(`reconciling Stream deletion ${streamId} (cycle ${cycle})`)
    try {
      await triggerReconciliation(request, base, reconcileToken, Math.max(1, deadline - Date.now()))
    } catch (error) {
      if (Date.now() >= deadline) break
      throw error
    }
    const response = await request(`${base}/api/workgraph/streams/${encodeURIComponent(streamId)}`, {
      headers: authorization(await createClerkSessionToken(request, clerkSecret, session)),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) return
    if (!response.ok) throw new Error(`Deleted Stream verification failed: ${response.status} ${await response.text()}`)
    await wait(Math.min(12_000, Math.max(0, deadline - Date.now())))
  }
  throw new Error("Hosted Stream cleanup did not complete within two minutes")
}

async function cleanupStream(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  reconcileToken: string,
  stream: SmokeStream,
  progress: (message: string) => void,
) {
  progress(`deleting smoke Stream ${stream.streamId}`)
  const token = await createClerkSessionToken(request, clerkSecret, stream.session)
  const current = await request(`${base}/api/workgraph/streams/${encodeURIComponent(stream.streamId)}`, {
    headers: authorization(token),
    signal: AbortSignal.timeout(15_000),
  })
  if (current.status === 404) {
    progress(`smoke Stream ${stream.streamId} was already deleted`)
    return
  }
  if (!current.ok) throw new Error(`Smoke Stream cleanup read failed: ${current.status} ${await current.text()}`)
  await command(request, base, token, stream.deleteOperationId, {
    version: 1,
    type: "delete_stream",
    streamId: stream.streamId,
    expectedVersion: 1,
    reason: stream.reason,
  })
  await reconcileDeletion(request, base, clerkSecret, stream.session, reconcileToken, stream.streamId, progress)
  progress(`deleted smoke Stream ${stream.streamId}`)
}

async function triggerReconciliation(request: typeof fetch, base: string, token: string, timeoutMs = 120_000) {
  const response = await request(`${base}/internal/workgraph/reconcile`, {
    method: "POST",
    headers: authorization(token),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = parseJson(await response.text(), "/internal/workgraph/reconcile")
  if (!response.ok || record(body)?.ok !== true) {
    throw new Error(`WorkGraph reconciliation trigger failed: ${response.status}`)
  }
}

function requireRecord(input: unknown, id: string, kind: string) {
  if (record(input)?.id !== id) throw new Error(`${kind} detail did not return ${id}`)
}

function records(input: unknown) {
  const value = record(input)?.records
  if (!Array.isArray(value)) throw new Error("WorkGraph snapshot returned no record collection")
  return value.map(record).filter((item): item is Record<string, unknown> => !!item)
}

function snapshotCursor(input: unknown) {
  const cursor = record(input)?.nextCursor
  if (typeof cursor !== "string" || !cursor.trim()) {
    throw new Error("Authenticated WorkGraph snapshot did not return a tenant-bound resume cursor")
  }
  return cursor
}

function stringArray(input: string, name: string) {
  const value = parseJson(input, name)
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be a JSON array of non-empty tool IDs`)
  }
  return value
}

function array(input: unknown): unknown[] {
  return Array.isArray(input) ? input : []
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

function commandValue(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`WorkGraph command returned no ${key}`)
  return value
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

if (import.meta.main) await workGraphSmoke()
