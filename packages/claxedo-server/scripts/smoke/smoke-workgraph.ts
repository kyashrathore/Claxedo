type SmokeEnvironment = Readonly<Record<string, string | undefined>>

type Session = Readonly<{ id: string; organizationId: string }>

export async function workGraphSmoke(env: SmokeEnvironment = process.env, request: typeof fetch = fetch) {
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

  const garbage = await request(`${base}/api/workgraph/snapshot?limit=1`, {
    headers: { authorization: `Bearer workgraph-smoke-invalid-${Date.now()}` },
  })
  if (garbage.status !== 401) throw new Error(`WorkGraph fail-closed probe expected 401, got ${garbage.status}`)

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
    await refreshExecutionCapabilities(request, base, clerkSecret, sessionAOrganizationA, retryDelayMs)
    const capabilities = await readExecutionCapabilities(request, base, clerkSecret, sessionAOrganizationA, retryDelayMs)
    const execution = requireExecutionProfile(capabilities, env)

    const tokenA = await createClerkSessionToken(request, clerkSecret, sessionAOrganizationA)
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
    try {
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
                instructions: "Do not edit files or call tools. Return one short deployment smoke confirmation.",
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

      const attemptId = commandValue(
        await command(request, base, tokenA, `${operationId}_execute`, {
          version: 1,
          type: "execute_work_item",
          workItemId,
          executionMode: "autonomous",
        }),
        "attemptId",
      )
      await reconcileAttempt(request, base, clerkSecret, sessionAOrganizationA, reconcileToken, attemptId)
      console.log(`WorkGraph hosted signed user-and-organization isolation and execution passed for ${streamId}`)
    } finally {
      await command(
        request,
        base,
        await createClerkSessionToken(request, clerkSecret, sessionAOrganizationA),
        `${operationId}_cleanup`,
        {
          version: 1,
          type: "delete_stream",
          streamId,
          expectedVersion: 1,
          reason: "Hosted deployment smoke cleanup",
        },
      )
      await reconcileDeletion(request, base, clerkSecret, sessionAOrganizationA, reconcileToken, streamId)
    }
  } finally {
    await Promise.all(sessions.map((session) => revokeClerkSession(request, clerkSecret, session)))
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
    throw new Error(`${boundary} accepted a snapshot cursor from the source tenant`)
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
  const tools = stringArray(
    required(env.WORKGRAPH_SMOKE_TOOLS_JSON, "WORKGRAPH_SMOKE_TOOLS_JSON"),
    "WORKGRAPH_SMOKE_TOOLS_JSON",
  )
  const environment = array(value.environments)
    .map(record)
    .find((item) => item?.kind === "hosted_workspace")
  if (environment?.repositoryRequired !== false) {
    throw new Error("Hosted execution capabilities do not support the smoke environment")
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
    environment: { kind: "hosted_workspace" as const },
    harness,
    agent,
    model: { providerId, modelId },
    effort,
    tools,
    connectionIds: [],
  }
}

async function reconcileAttempt(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  session: Session,
  reconcileToken: string,
  attemptId: string,
) {
  for (let cycle = 0; cycle < 30; cycle += 1) {
    await triggerReconciliation(request, base, reconcileToken)
    const detail = record(
      await jsonRequest(request, `${base}/api/workgraph/attempts/${encodeURIComponent(attemptId)}`, {
        headers: authorization(await createClerkSessionToken(request, clerkSecret, session)),
      }),
    )
    const attempt = record(detail?.attempt)
    if (attempt?.id !== attemptId || typeof attempt.state !== "string") {
      throw new Error("Hosted Attempt detail returned an invalid envelope")
    }
    if (attempt.state === "result") {
      const references = record(detail?.executionReferences)
      if (typeof references?.workspaceId !== "string" || typeof references.sessionId !== "string") {
        throw new Error("Hosted Attempt result has no durable Workspace and Session references")
      }
      return
    }
    if (attempt.state === "attention" || attempt.state === "failed" || attempt.state === "cancelled") {
      throw new Error(`Hosted Attempt reached ${attempt.state} instead of a result`)
    }
    await wait(12_000)
  }
  throw new Error("Hosted Attempt did not produce a result within six minutes")
}

async function reconcileDeletion(
  request: typeof fetch,
  base: string,
  clerkSecret: string,
  session: Session,
  reconcileToken: string,
  streamId: string,
) {
  for (let cycle = 0; cycle < 10; cycle += 1) {
    await triggerReconciliation(request, base, reconcileToken)
    const response = await request(`${base}/api/workgraph/streams/${encodeURIComponent(streamId)}`, {
      headers: authorization(await createClerkSessionToken(request, clerkSecret, session)),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) return
    if (!response.ok) throw new Error(`Deleted Stream verification failed: ${response.status} ${await response.text()}`)
    await wait(12_000)
  }
  throw new Error("Hosted Stream cleanup did not complete within two minutes")
}

async function triggerReconciliation(request: typeof fetch, base: string, token: string) {
  const response = await request(`${base}/internal/workgraph/reconcile`, {
    method: "POST",
    headers: authorization(token),
    signal: AbortSignal.timeout(120_000),
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
