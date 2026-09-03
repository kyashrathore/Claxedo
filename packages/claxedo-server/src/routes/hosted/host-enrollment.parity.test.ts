import { createPrivateKey, generateKeyPairSync, sign as signData } from "node:crypto"
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import type { ClerkVerifier, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { createConvexAuthority } from "../../authority/adapters/convex/workspace-authority/index"
import type { ControlPlaneServices } from "../../authority/services"
import { HostEnrollmentRoutes } from "./host-enrollment"
import schema from "../../../../../convex/schema"

/**
 * Machine enrollment, through the HTTP routes, against BOTH authorities.
 *
 * This exists because of a defect it would have caught on day one: the five
 * enrollment methods were implemented on the SQLite authority and MISSING from
 * the Convex one, so the entire feature answered 501 on the production backend
 * while a fully green suite reported otherwise. Every test that covered it —
 * the SQLite authority suite, the Convex policy suite, the route suite over a
 * `vi.fn()` double — was true, and none of them could see it: no test ran a
 * route against the Convex adapter.
 *
 * So the unit under test here is neither authority. It is the CLAIM that the
 * two are interchangeable behind `WorkspaceAuthority`: same request in, same
 * status and same response body out, whichever backend a deployment composed.
 * Both sides are real — a real SQLite database and the real
 * `convex/hostEnrollments.ts` functions driven through `convex-test`, reached
 * through the real Convex adapter, with the real Hono routes on top. The only
 * doubles are the Clerk verifier and the clock the two backends each read for
 * themselves.
 *
 * Each scenario declares the outcome it expects ONCE and both backends are
 * asserted against it, rather than only against each other. Backend-to-backend
 * equality alone would pass if both were broken the same way — two 501s are
 * equal — and "no route reaches this code" is exactly the failure being
 * defended against.
 */

const modules = import.meta.glob("../../../../../convex/**/*.ts")

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

/**
 * The bearer IS the subject, so a request's principal is readable at the call
 * site. The identity it yields is the same one the Convex side is driven with,
 * which is what makes "the same user" mean the same thing on both backends:
 * SQLite keys its rows on `token_identifier`, and so does `convex/model.ts`.
 */
const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

function convexIdentity(subject: string) {
  return { tokenIdentifier: `${authConfig.issuer}|${subject}`, subject }
}

function hostKey() {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const jwk = pair.privateKey.export({ format: "jwk" })
  return {
    publicKey: JSON.stringify(pair.publicKey.export({ format: "jwk" })),
    sign(payload: string) {
      return signData("sha256", Buffer.from(payload), {
        key: createPrivateKey({ key: jwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }).toString("base64url")
    },
  }
}

function enrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * Heartbeat payload v2: the machine's ONE signature per interval also covers
 * the workspaces it currently serves (sorted, comma-joined). Restated here
 * rather than imported so a drift in either authority's literal fails parity
 * instead of following it.
 */
function heartbeatPayload(input: { hostId: string; ttlMs?: number; workspaceIds: readonly string[] }) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
    `workspaces=${[...input.workspaceIds].sort().join(",")}`,
  ].join("\n")
}

type Recorded = { status: number; body: unknown }

/**
 * convex-test's `query`/`mutation` are typed for a generated, statically known
 * API; the adapter reaches them through `anyApi` references, which is the whole
 * point of an untyped executor port. One narrow alias rather than a cast at
 * each of the four call sites.
 */
type ConvexTestCall = (fn: unknown, args: unknown) => Promise<unknown>

/**
 * Values that legitimately differ run to run — random ids, server clocks —
 * replaced by their TYPE rather than dropped.
 *
 * Dropping them would stop the comparison seeing a field that vanished on one
 * backend; keeping the raw value would compare two clocks. `<number>` keeps the
 * key, its presence, and its type in the compared shape, which is the part that
 * has to match.
 */
const VOLATILE = new Set(["enrollment_id", "request_id", "nonce", "expires_at", "last_seen_at", "created_at", "retryAfterMs"])

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        VOLATILE.has(key) ? `<${typeof item}>` : stable(item),
      ]),
    )
  }
  return value
}

type Client = {
  post(path: string, body: unknown): Promise<Recorded>
  get(path: string): Promise<Recorded>
}

/** The scenario's view of a deployment: any number of principals, one backend. */
type Deployment = { as(subject: string): Client }

async function recorded(response: Response): Promise<Recorded> {
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    // Hono's own 500 body is plain text; comparing it is still worthwhile,
    // because a backend that failed differently would say something else.
    return { status: response.status, body: text }
  }
}

function deployment(authorityFor: (subject: string) => WorkspaceAuthority): Deployment {
  const clients = new Map<string, Client>()
  return {
    as(subject) {
      const cached = clients.get(subject)
      if (cached) return cached
      const services = { authority: authorityFor(subject) } as unknown as ControlPlaneServices
      const app = HostEnrollmentRoutes(services, { authConfig, verifier } as never)
      const call = async (path: string, init: RequestInit) =>
        recorded(await app.request(`http://control.test${path}`, {
          headers: { authorization: `Bearer ${subject}`, "content-type": "application/json" },
          ...init,
        }))
      const client: Client = {
        post: (path, body) => call(path, { method: "POST", body: JSON.stringify(body) }),
        get: (path) => call(path, { method: "GET" }),
      }
      clients.set(subject, client)
      return client
    },
  }
}

/**
 * One SQLite database for the whole deployment, shared by every principal —
 * the production shape, where isolation between users is the authority's job
 * rather than the harness's.
 */
function sqliteDeployment(): Deployment {
  const authority = createSqliteWorkspaceAuthority({ path: ":memory:" })
  return deployment(() => authority)
}

/**
 * One Convex deployment, with a per-principal executor.
 *
 * The executor is where a bearer becomes an identity in production
 * (`executor()` in the adapter sets it on a fresh `ConvexHttpClient` per call),
 * so binding `t.withIdentity` per subject is the faithful stand-in: the adapter
 * itself, and every Convex function under it, runs unmodified.
 */
function convexDeployment(): Deployment {
  const t = convexTest(schema, modules)
  return deployment((subject) => {
    const as = t.withIdentity(convexIdentity(subject))
    return createConvexAuthority({
      executor: {
        query: (fn, args) => (as.query as ConvexTestCall)(fn, args),
        mutation: (fn, args) => (as.mutation as ConvexTestCall)(fn, args),
      },
    })
  })
}

const BACKENDS = [
  { name: "sqlite", deployment: sqliteDeployment },
  { name: "convex", deployment: convexDeployment },
] as const

/** Runs one scenario on every backend and holds each to the same expectation. */
function parity(name: string, scenario: (env: Deployment) => Promise<unknown>, expected: unknown) {
  test(name, async () => {
    for (const backend of BACKENDS) {
      expect(await scenario(backend.deployment()), backend.name).toEqual(expected)
    }
  })
}

/** The whole handshake, as the Host Connector performs it. */
async function enroll(
  client: Client,
  input: { hostId?: string; key?: ReturnType<typeof hostKey>; displayName?: string } = {},
) {
  const hostId = input.hostId ?? "host_laptop"
  const key = input.key ?? hostKey()
  const request = await client.post("/requests", { hostId })
  const challenge = request.body as { request_id: string; nonce: string }
  const enrollment = await client.post("/", {
    hostId,
    publicKey: key.publicKey,
    requestId: challenge.request_id,
    signature: key.sign(enrollmentPayload({ hostId, requestId: challenge.request_id, nonce: challenge.nonce })),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  })
  return { hostId, key, request, challenge, enrollment }
}

describe("host enrollment is the same feature on both authorities", () => {
  parity(
    "issues a challenge, records the enrollment, and reports the machine active",
    async (env) => {
      const owner = env.as("user_owner")
      const { request, enrollment } = await enroll(owner, { displayName: "Work laptop" })
      const active = await owner.get("/")
      return stable({ request, enrollment, active })
    },
    {
      request: { status: 200, body: { request_id: "<string>", nonce: "<string>", expires_at: "<number>" } },
      // `{ enrollment }` — the route's own envelope. A backend that returned the
      // bare enrollment, or added a field to it, fails here rather than in a
      // desktop decoder.
      enrollment: {
        status: 200,
        body: {
          enrollment: {
            enrollment_id: "<string>",
            host_id: "host_laptop",
            display_name: "Work laptop",
            expires_at: "<number>",
            last_seen_at: "<number>",
            created_at: "<number>",
          },
        },
      },
      active: {
        status: 200,
        body: {
          active: true,
          enrollment_id: "<string>",
          host_id: "host_laptop",
          display_name: "Work laptop",
          expires_at: "<number>",
          last_seen_at: "<number>",
          created_at: "<number>",
        },
      },
    },
  )

  parity(
    "never puts the host public key on the wire",
    async (env) => {
      const owner = env.as("user_owner")
      const { key, enrollment } = await enroll(owner)
      const active = await owner.get("/")
      return [enrollment, active].map((response) => JSON.stringify(response.body).includes(key.publicKey))
    },
    [false, false],
  )

  parity(
    "answers not-enrolled, rather than failing, for a user with no machines",
    async (env) => stable(await env.as("user_owner").get("/")),
    { status: 200, body: { active: false, reason: "not-enrolled" } },
  )

  parity(
    "refuses a forged signature and does not burn the challenge",
    async (env) => {
      const owner = env.as("user_owner")
      const presented = hostKey()
      const attacker = hostKey()
      const { request_id, nonce } = (await owner.post("/requests", { hostId: "host_laptop" })).body as {
        request_id: string
        nonce: string
      }
      const body = (signature: string) => ({
        hostId: "host_laptop",
        publicKey: presented.publicKey,
        requestId: request_id,
        signature,
      })

      const forged = await owner.post("/", body(attacker.sign(enrollmentPayload({ hostId: "host_laptop", requestId: request_id, nonce }))))
      // The same challenge, answered honestly. If a bad signature burned it,
      // anyone able to reach this route could lock a user out of enrolling.
      const honest = await owner.post("/", body(presented.sign(enrollmentPayload({ hostId: "host_laptop", requestId: request_id, nonce }))))
      return stable({ forged: forged.status, honest })
    },
    {
      forged: 500,
      honest: {
        status: 200,
        body: {
          enrollment: {
            enrollment_id: "<string>",
            host_id: "host_laptop",
            expires_at: "<number>",
            last_seen_at: "<number>",
            created_at: "<number>",
          },
        },
      },
    },
  )

  parity(
    "spends a challenge exactly once",
    async (env) => {
      const owner = env.as("user_owner")
      const { hostId, key, challenge } = await enroll(owner)
      const replay = await owner.post("/", {
        hostId,
        publicKey: key.publicKey,
        requestId: challenge.request_id,
        signature: key.sign(enrollmentPayload({ hostId, requestId: challenge.request_id, nonce: challenge.nonce })),
      })
      return replay.status
    },
    500,
  )

  parity(
    "will not let one user spend another user's challenge",
    async (env) => {
      const key = hostKey()
      const challenge = (await env.as("user_owner").post("/requests", { hostId: "host_laptop" })).body as {
        request_id: string
        nonce: string
      }
      const stolen = await env.as("user_other").post("/", {
        hostId: "host_laptop",
        publicKey: key.publicKey,
        requestId: challenge.request_id,
        signature: key.sign(
          enrollmentPayload({ hostId: "host_laptop", requestId: challenge.request_id, nonce: challenge.nonce }),
        ),
      })
      return stolen.status
    },
    500,
  )

  parity(
    "extends a live machine on a heartbeat signed with the enrolled key",
    async (env) => {
      const owner = env.as("user_owner")
      const { hostId, key, enrollment } = await enroll(owner)
      const workspaceIds: string[] = []
      const beat = await owner.post("/heartbeat", {
        hostId,
        signature: key.sign(heartbeatPayload({ hostId, workspaceIds })),
        workspaceIds,
      })
      const enrolledExpiry = (enrollment.body as { enrollment: { expires_at: number } }).enrollment.expires_at
      const beatBody = beat.body as { expires_at: number }
      return { ...(stable(beat) as Record<string, unknown>), extended: beatBody.expires_at >= enrolledExpiry }
    },
    {
      status: 200,
      // The owner's assignment view rides back on every ack (empty here — no
      // workspace was assigned). No `hostTunnel`: the route mints one only
      // when a signer is configured AND the beat acked an assigned workspace.
      body: { expires_at: "<number>", last_seen_at: "<number>", assigned_workspace_ids: [] },
      extended: true,
    },
  )

  parity(
    "refuses a heartbeat signed with any other key",
    async (env) => {
      const owner = env.as("user_owner")
      const { hostId } = await enroll(owner)
      const attacker = hostKey()
      return (await owner.post("/heartbeat", {
        hostId,
        signature: attacker.sign(heartbeatPayload({ hostId, workspaceIds: [] })),
        workspaceIds: [],
      })).status
    },
    500,
  )

  parity(
    "refuses a heartbeat whose signature covers a different served set",
    async (env) => {
      // The v2 payload binds the signature to the acked workspaces. Accepting
      // a body whose set differs from the signed one would let a stolen beat
      // ack workspaces the machine never consented to serve.
      const owner = env.as("user_owner")
      const { hostId, key } = await enroll(owner)
      return (await owner.post("/heartbeat", {
        hostId,
        signature: key.sign(heartbeatPayload({ hostId, workspaceIds: [] })),
        workspaceIds: ["ws_injected"],
      })).status
    },
    500,
  )

  parity(
    "pausing one machine reports the reason, and resuming brings it back",
    async (env) => {
      const owner = env.as("user_owner")
      const { hostId } = await enroll(owner)
      const paused = await owner.post("/pause", { hostId, paused: true })
      const whilePaused = await owner.get("/")
      const resumed = await owner.post("/pause", { hostId, paused: false })
      const afterResume = await owner.get("/")
      return stable({ paused, whilePaused, resumed, active: (afterResume.body as { active: boolean }).active })
    },
    {
      // `{ paused }` and nothing else. Convex's own `pause` also returns how
      // many rows it touched; the adapter narrows that away, because this body
      // is what `POST /pause` returns verbatim and the two backends must not
      // hand clients different objects.
      paused: { status: 200, body: { paused: true } },
      whilePaused: { status: 200, body: { active: false, reason: "paused" } },
      resumed: { status: 200, body: { paused: false } },
      active: true,
    },
  )

  parity(
    "pausing with no host id stops every machine this owner enrolled",
    async (env) => {
      const owner = env.as("user_owner")
      await enroll(owner, { hostId: "host_a" })
      await enroll(owner, { hostId: "host_b" })
      const paused = await owner.post("/pause", { paused: true })
      const active = await owner.get("/")
      return stable({ paused, active })
    },
    {
      paused: { status: 200, body: { paused: true } },
      active: { status: 200, body: { active: false, reason: "paused" } },
    },
  )

  parity(
    "keeps one owner's machines out of another owner's answers",
    async (env) => {
      await enroll(env.as("user_owner"), { hostId: "host_shared" })
      const other = await env.as("user_other").get("/")
      // Same machine id, a different account: uniqueness is per (owner, host),
      // and a shared machine is not one user's to claim.
      const otherEnrolls = await enroll(env.as("user_other"), { hostId: "host_shared" })
      await env.as("user_owner").post("/pause", { paused: true })
      const otherAfterOwnerPause = await env.as("user_other").get("/")
      return stable({
        beforeOtherEnrolls: other,
        otherEnrollStatus: otherEnrolls.enrollment.status,
        otherStillActive: (otherAfterOwnerPause.body as { active: boolean }).active,
      })
    },
    {
      beforeOtherEnrolls: { status: 200, body: { active: false, reason: "not-enrolled" } },
      otherEnrollStatus: 200,
      otherStillActive: true,
    },
  )

  parity(
    "re-enrolling a machine renames it, keeps its id, and clears a pause",
    async (env) => {
      const owner = env.as("user_owner")
      const first = await enroll(owner, { displayName: "Laptop" })
      await owner.post("/pause", { hostId: first.hostId, paused: true })
      const again = await enroll(owner, { hostId: first.hostId, key: first.key, displayName: "Laptop renamed" })
      const active = await owner.get("/")
      const idOf = (response: Recorded) =>
        (response.body as { enrollment: { enrollment_id: string } }).enrollment.enrollment_id
      return stable({
        again: again.enrollment,
        active,
        // Re-enrolling updates the machine rather than minting a second one.
        // A backend that issued a fresh id here would invalidate anything a
        // client had stored against the old one.
        sameId: idOf(first.enrollment) === idOf(again.enrollment),
      })
    },
    {
      again: {
        status: 200,
        body: {
          enrollment: {
            enrollment_id: "<string>",
            host_id: "host_laptop",
            display_name: "Laptop renamed",
            expires_at: "<number>",
            last_seen_at: "<number>",
            created_at: "<number>",
          },
        },
      },
      active: {
        status: 200,
        body: {
          active: true,
          enrollment_id: "<string>",
          host_id: "host_laptop",
          display_name: "Laptop renamed",
          expires_at: "<number>",
          last_seen_at: "<number>",
          created_at: "<number>",
        },
      },
      sameId: true,
    },
  )

  parity(
    "honours the client's requested TTL on both the enrollment and the renewal",
    async (env) => {
      const owner = env.as("user_owner")
      const hostId = "host_laptop"
      const key = hostKey()
      const challenge = (await owner.post("/requests", { hostId })).body as { request_id: string; nonce: string }
      const before = Date.now()
      const enrollment = await owner.post("/", {
        hostId,
        publicKey: key.publicKey,
        requestId: challenge.request_id,
        signature: key.sign(enrollmentPayload({ hostId, requestId: challenge.request_id, nonce: challenge.nonce })),
        ttlMs: 120_000,
      })
      const beat = await owner.post("/heartbeat", {
        hostId,
        signature: key.sign(heartbeatPayload({ hostId, ttlMs: 120_000, workspaceIds: [] })),
        ttlMs: 120_000,
        workspaceIds: [],
      })
      // A window rather than an instant: each backend reads its own clock. The
      // claim is that a requested TTL is applied, not clamped to the 60s
      // default, on either of them.
      const within = (value: number) => value - before >= 120_000 && value - before < 125_000
      return {
        enrolled: within((enrollment.body as { enrollment: { expires_at: number } }).enrollment.expires_at),
        renewed: within((beat.body as { expires_at: number }).expires_at),
      }
    },
    { enrolled: true, renewed: true },
  )
})

/**
 * The five methods, as the port declares them.
 *
 * The parity scenarios above already fail when one is missing — a 501 does not
 * equal a 200 — but they fail with a status mismatch buried in a scenario about
 * pausing. This says the thing directly, so the fix is obvious from the failure
 * line alone, and it holds for BOTH authorities so neither can drift into
 * implementing a subset.
 */
describe("both authorities implement the whole enrollment port", () => {
  const METHODS = [
    "createHostEnrollmentRequest",
    "enrollHost",
    "heartbeatHostEnrollment",
    "pauseHostEnrollment",
    "activeHostEnrollment",
    // The owner-assignment grain that replaced per-workspace links: assign,
    // unassign, and the routing read that requires assigned ∩ acked ∩ live.
    "assignWorkspaceHost",
    "unassignWorkspaceHost",
    "activeWorkspaceHost",
  ] as const

  test("sqlite", () => {
    const authority = createSqliteWorkspaceAuthority({ path: ":memory:" }) as unknown as Record<string, unknown>
    expect(METHODS.filter((name) => typeof authority[name] === "function")).toEqual([...METHODS])
  })

  test("convex", () => {
    const authority = createConvexAuthority({
      executor: { query: async () => ({}), mutation: async () => ({}) },
    }) as unknown as Record<string, unknown>
    expect(METHODS.filter((name) => typeof authority[name] === "function")).toEqual([...METHODS])
  })
})
