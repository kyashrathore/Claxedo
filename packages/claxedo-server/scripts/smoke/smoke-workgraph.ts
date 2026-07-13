type SmokeEnvironment = Readonly<Record<string, string | undefined>>

type Session = Readonly<{ id: string }>

export async function workGraphSmoke(env: SmokeEnvironment = process.env, request: typeof fetch = fetch) {
  const base = required(env.BASE_URL, "BASE_URL").replace(/\/+$/, "")
  const clerkSecret = required(env.CLERK_SECRET_KEY, "CLERK_SECRET_KEY")
  const userA = required(env.WORKGRAPH_SMOKE_USER_A_ID, "WORKGRAPH_SMOKE_USER_A_ID")
  const userB = required(env.WORKGRAPH_SMOKE_USER_B_ID, "WORKGRAPH_SMOKE_USER_B_ID")
  const workspaceId = required(env.WORKGRAPH_SMOKE_WORKSPACE_ID, "WORKGRAPH_SMOKE_WORKSPACE_ID")
  if (userA === userB) throw new Error("WorkGraph smoke identities must be different users")

  const garbage = await request(`${base}/api/workgraph/snapshot?limit=1`, {
    headers: { authorization: `Bearer workgraph-smoke-invalid-${Date.now()}` },
  })
  if (garbage.status !== 401) throw new Error(`WorkGraph fail-closed probe expected 401, got ${garbage.status}`)

  const firstSession = await createClerkSession(request, clerkSecret, userA)
  const sessions = [
    firstSession,
    await createClerkSession(request, clerkSecret, userB).catch(async (error) => {
      await revokeClerkSession(request, clerkSecret, firstSession)
      throw error
    }),
  ]
  try {
    const capabilityToken = await createClerkSessionToken(request, clerkSecret, sessions[0])
    const capabilities = await jsonRequest(request, `${base}/api/workgraph/execution-capabilities?workspaceId=${encodeURIComponent(workspaceId)}`, {
      headers: authorization(capabilityToken),
    })
    requireHostedCapabilities(capabilities, workspaceId)

    const tokenA = await createClerkSessionToken(request, clerkSecret, sessions[0])
    const operationId = `smoke_${Date.now()}`
    const streamId = commandValue(await command(request, base, tokenA, operationId, {
      version: 1,
      type: "create_stream",
      title: `Hosted smoke ${operationId}`,
    }), "streamId")
    try {
      const workItemId = commandValue(await command(request, base, tokenA, `${operationId}_task`, {
        version: 1,
        type: "create_work_item",
        streamId,
        title: "Verify the deployed WorkGraph composition",
        completionContract: {
          version: 1,
          mode: "all",
          requirements: [{
            id: "hosted_smoke",
            kind: "verification",
            description: "The signed Cloud composition persists an owner-scoped Task",
            instructions: "Verify through the authenticated WorkGraph detail contract",
          }],
        },
      }), "workItemId")

      const [stream, task, snapshot] = await Promise.all([
        jsonRequest(request, `${base}/api/workgraph/streams/${encodeURIComponent(streamId)}`, { headers: authorization(tokenA) }),
        jsonRequest(request, `${base}/api/workgraph/work-items/${encodeURIComponent(workItemId)}`, { headers: authorization(tokenA) }),
        jsonRequest(request, `${base}/api/workgraph/snapshot?limit=100`, { headers: authorization(tokenA) }),
      ])
      requireRecord(stream, streamId, "Stream")
      requireRecord(task, workItemId, "Task")
      if (!records(snapshot).some((record) => record.id === streamId) || !records(snapshot).some((record) => record.id === workItemId)) {
        throw new Error("Created Stream and Task are absent from the authenticated Convex snapshot")
      }

      const tokenB = await createClerkSessionToken(request, clerkSecret, sessions[1])
      const otherSnapshot = await jsonRequest(request, `${base}/api/workgraph/snapshot?limit=100`, { headers: authorization(tokenB) })
      if (records(otherSnapshot).some((record) => record.id === streamId || record.id === workItemId)) {
        throw new Error("A second signed identity observed the first identity's WorkGraph records")
      }
      const crossUser = await request(`${base}/api/workgraph/streams/${encodeURIComponent(streamId)}`, {
        headers: authorization(tokenB),
      })
      if (crossUser.status !== 404) {
        throw new Error(`Cross-user Stream read expected an indistinguishable 404, got ${crossUser.status}`)
      }
      console.log(`WorkGraph hosted signed two-user persistence passed for ${streamId}`)
    } finally {
      await command(
        request,
        base,
        await createClerkSessionToken(request, clerkSecret, sessions[0]),
        `${operationId}_cleanup`,
        {
          version: 1,
          type: "delete_stream",
          streamId,
          expectedVersion: 1,
          reason: "Hosted deployment smoke cleanup",
        },
      )
    }
  } finally {
    await Promise.all(sessions.map((session) => revokeClerkSession(request, clerkSecret, session)))
  }
}

async function createClerkSession(request: typeof fetch, secret: string, userId: string): Promise<Session> {
  const body = await jsonRequest(request, "https://api.clerk.com/v1/sessions", {
    method: "POST",
    headers: clerkHeaders(secret),
    body: JSON.stringify({ user_id: userId }),
  })
  const id = record(body)?.id
  if (typeof id !== "string" || !id.trim()) throw new Error("Clerk session creation returned no Session ID")
  return { id }
}

async function createClerkSessionToken(request: typeof fetch, secret: string, session: Session) {
  const body = await jsonRequest(request, `https://api.clerk.com/v1/sessions/${encodeURIComponent(session.id)}/tokens`, {
    method: "POST",
    headers: clerkHeaders(secret),
  })
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

async function command(request: typeof fetch, base: string, token: string, operationId: string, body: Record<string, unknown>) {
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

function requireHostedCapabilities(input: unknown, workspaceId: string) {
  const value = record(input)
  if (value?.schemaVersion !== 1 || value.workspaceId !== workspaceId || typeof value.ownerUserId !== "string") {
    throw new Error("WorkGraph execution capability route returned an invalid owner/workspace envelope")
  }
  const environments = Array.isArray(value.environments) ? value.environments : []
  if (!environments.some((environment) => record(environment)?.kind === "hosted_workspace")) {
    throw new Error("WorkGraph execution capability route did not advertise the hosted Workspace environment")
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

function commandValue(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string" || !value.trim()) throw new Error(`WorkGraph command returned no ${key}`)
  return value
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function required(value: string | undefined, name: string) {
  const cleaned = value?.trim()
  if (!cleaned) throw new Error(`${name} is required`)
  return cleaned
}

function authorization(token: string) {
  return { authorization: `Bearer ${token}` }
}

function clerkHeaders(secret: string) {
  return { authorization: `Bearer ${secret}`, "content-type": "application/json" }
}

if (import.meta.main) await workGraphSmoke()
