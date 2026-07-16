import { Webhook } from "svix"

type SmokeEnvironment = Readonly<Record<string, string | undefined>>

export async function syncClerkWorkGraphFixtures(
  env: SmokeEnvironment = process.env,
  request: typeof fetch = fetch,
) {
  const clerkSecret = required(env.CLERK_SECRET_KEY, "CLERK_SECRET_KEY")
  const webhookSecret = required(env.CLERK_WEBHOOK_SECRET, "CLERK_WEBHOOK_SECRET")
  const users = [
    required(env.WORKGRAPH_SMOKE_USER_A_ID, "WORKGRAPH_SMOKE_USER_A_ID"),
    required(env.WORKGRAPH_SMOKE_USER_B_ID, "WORKGRAPH_SMOKE_USER_B_ID"),
  ]
  const organizations = [
    required(env.WORKGRAPH_SMOKE_ORGANIZATION_A_ID, "WORKGRAPH_SMOKE_ORGANIZATION_A_ID"),
    required(env.WORKGRAPH_SMOKE_ORGANIZATION_B_ID, "WORKGRAPH_SMOKE_ORGANIZATION_B_ID"),
  ]
  const webhookURL = `${convexSiteURL(required(env.CONVEX_URL, "CONVEX_URL"))}/api/clerk/webhook`
  const [userRecords, organizationRecords, membershipPages] = await Promise.all([
    Promise.all(users.map((id) => clerkGet(request, clerkSecret, `/v1/users/${encodeURIComponent(id)}`))),
    Promise.all(
      organizations.map((id) => clerkGet(request, clerkSecret, `/v1/organizations/${encodeURIComponent(id)}`)),
    ),
    Promise.all(
      organizations.map((id) =>
        clerkGet(request, clerkSecret, `/v1/organizations/${encodeURIComponent(id)}/memberships?limit=500`),
      ),
    ),
  ])
  const memberships = membershipPages.flatMap((page) => array(record(page)?.data))
  const requiredMemberships = [
    [organizations[0]!, users[0]!],
    [organizations[1]!, users[0]!],
    [organizations[0]!, users[1]!],
  ].map(([organizationId, userId]) => {
    const membership = memberships.find(
      (candidate) => membershipOrganizationId(candidate) === organizationId && membershipUserId(candidate) === userId,
    )
    if (!membership) throw new Error(`Clerk smoke fixture membership ${organizationId}/${userId} is required`)
    return membership
  })
  for (const event of [
    ...userRecords.map((data) => ({ type: "user.created", data })),
    ...organizationRecords.map((data) => ({ type: "organization.created", data })),
    ...requiredMemberships.map((data) => ({ type: "organizationMembership.created", data })),
  ]) {
    await deliverWebhook(request, webhookURL, webhookSecret, event)
  }
  console.log("Synchronized Clerk WorkGraph smoke fixture identities and memberships")
}

async function clerkGet(request: typeof fetch, secret: string, path: string) {
  const response = await request(`https://api.clerk.com${path}`, {
    headers: { authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Clerk fixture read ${new URL(response.url).pathname} failed: ${response.status}`)
  return parseJson(body, "Clerk fixture read")
}

async function deliverWebhook(
  request: typeof fetch,
  url: string,
  secret: string,
  event: Readonly<{ type: string; data: unknown }>,
) {
  const payload = JSON.stringify(event)
  const id = `msg_workgraph_${crypto.randomUUID()}`
  const timestamp = new Date()
  const response = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, timestamp, payload),
    },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Convex Clerk fixture webhook failed: ${response.status} ${await response.text()}`)
}

function convexSiteURL(value: string) {
  const url = new URL(value)
  if (url.hostname.endsWith(".convex.cloud")) url.hostname = `${url.hostname.slice(0, -".convex.cloud".length)}.convex.site`
  if (!url.hostname.endsWith(".convex.site")) throw new Error("CONVEX_URL must use a Convex deployment host")
  return url.origin
}

function membershipOrganizationId(input: unknown) {
  const value = record(input)
  return text(record(value?.organization)?.id) ?? text(value?.organization_id)
}

function membershipUserId(input: unknown) {
  const value = record(input)
  return text(record(value?.public_user_data)?.user_id) ?? text(value?.user_id)
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

function array(input: unknown): unknown[] {
  return Array.isArray(input) ? input : []
}

function text(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function parseJson(input: string, source: string) {
  try {
    return JSON.parse(input) as unknown
  } catch {
    throw new Error(`${source} returned malformed JSON`)
  }
}

function required(value: string | undefined, name: string) {
  const result = value?.trim()
  if (!result) throw new Error(`${name} is required`)
  return result
}

if (import.meta.main) await syncClerkWorkGraphFixtures()
