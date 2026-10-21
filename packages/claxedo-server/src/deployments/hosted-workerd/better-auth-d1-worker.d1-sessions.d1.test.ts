import { afterEach, expect, test } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import type { ExecutionContext } from "hono"
import { betterAuthD1WorkerEnv, workerDatabases, WORKER_ORIGIN as API, type WorkerDatabases } from "../../test-support/better-auth-d1-worker-env"
import worker, { betterAuthD1CompositionInput, createBetterAuthD1Worker, d1SessionStart, type BetterAuthD1WorkerEnv } from "./better-auth-d1-worker.cf"
import { composeBetterAuthD1UserDeployedControlPlane } from "../../authority/adapters/worker/better-auth-d1-compose"
import { settledCompositionCache } from "./settled-composition-cache"
import { generateCanonicalOwnerClaim, ownerClaimMutationSql, ownerClaimProvisioning } from "../../../scripts/deploy/claim-owner"
import { USER_DEPLOYED_OWNER_CLAIM_HEADER } from "../../authority/adapters/d1/owner-identity"

const active: WorkerDatabases[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((databases) => databases.dispose()))
})

/** The binding, recording where every session the Worker opens on it starts. */
function recording(database: D1Database, opened: string[]): D1Database {
  return new Proxy(database, {
    get(target, key, receiver) {
      if (key === "withSession") {
        return (start: string) => {
          opened.push(start)
          return target.withSession(start)
        }
      }
      const value: unknown = Reflect.get(target, key, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function bookmark(response: Response, name: "auth" | "control") {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`__Host-claxedo.d1-${name}=`))
  return cookie?.split("; ")[0]?.split("=")[1]
}

test("a read starts at a replica only for a client that carries bookmarks; anything that may write, and the two verification-consuming reads, start at the primary", () => {
  const signed = { cookie: "__Secure-claxedo.session_token=token" }
  const echoing = { "x-claxedo-d1-bookmarks": "control=00000000-00000001-00000000-00000000000000000000000000000000" }
  const start = (method: string, path: string, headers: Record<string, string> = {}) => d1SessionStart(new Request(`${API}${path}`, { method, headers }))
  expect(start("GET", "/api/auth/get-session", signed)).toBe("replica")
  expect(start("GET", "/api/workspace?host=provisioner", signed)).toBe("replica")
  expect(start("HEAD", "/api/control/session-list", signed)).toBe("replica")
  expect(start("GET", "/api/workspace?host=provisioner", { authorization: "Bearer desktop", ...echoing })).toBe("replica")
  expect(start("GET", "/api/workspace?host=provisioner", { authorization: "Bearer desktop" })).toBe("primary")
  expect(start("GET", "/internal/relay/target?workspace=ws_1", { authorization: "Bearer resolver" })).toBe("primary")
  for (const path of [
    "/api/auth/callback/github?code=c&state=s",
    "/api/auth/reset-password/token?callbackURL=/",
    "/api/auth/verify-email?token=t",
    "/api/auth/delete-user/callback?token=t",
    "/api/auth/device?user_code=ABCD-EFGH",
    "/api/auth/oauth2/authorize?client_id=mcp&response_type=code",
    "/api/claxedo/integrations/callback?state=s&code=c",
    "/api/claxedo/integrations/attempts/state_1",
  ]) expect(start("GET", path, signed), path).toBe("primary")
  expect(start("GET", "/api/auth/device-sessions", signed)).toBe("replica")
  expect(start("GET", "/api/claxedo/integrations/", signed)).toBe("replica")
  expect(start("GET", "/api/claxedo/auth/profile", { ...signed, "x-claxedo-bootstrap-owner-claim": "claim" })).toBe("primary")
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(start(method, "/api/workspace", { ...signed, ...echoing })).toBe("primary")
})

test("a sign-up writes through a primary session and hands back its bookmark, and the next read starts from it and sees the account", async () => {
  const bound = await workerDatabases()
  active.push(bound)
  const opened = { auth: [] as string[], control: [] as string[] }
  const mail: string[] = []
  const env = betterAuthD1WorkerEnv(
    { authDatabase: recording(bound.authDatabase, opened.auth), controlPlaneDatabase: recording(bound.controlPlaneDatabase, opened.control) },
    {
      CLAXEDO_D1_EDGE_READS: "on",
    CLAXEDO_AUTH_METHODS: "github,email-password",
      CLAXEDO_EMAIL_FROM: "sign-in@example.test",
      EMAIL: { send: async (message: { text: string }) => { mail.push(message.text); return { messageId: "m" } } },
    },
  )
  const readiness: Promise<unknown>[] = []
  const context = { waitUntil: (work: Promise<unknown>) => void readiness.push(work) } as unknown as ExecutionContext
  const json = (body: unknown, cookie = "") => ({
    method: "POST",
    headers: { "content-type": "application/json", origin: API, "cf-connecting-ip": "10.0.0.1", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

  const signedUp = await worker.fetch(new Request(`${API}/api/auth/sign-up/email`, json({ email: "ada@example.test", password: "correct-horse-battery-staple", name: "Ada" })), env, context)
  expect(signedUp.status, await signedUp.clone().text()).toBe(200)
  expect(opened.auth).toEqual(["first-primary"])
  const written = bookmark(signedUp, "auth")
  expect(written).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/)

  const verification = mail.at(-1)?.split("\n").at(-1)
  if (!verification) throw new Error("no verification mail")
  const verified = await worker.fetch(new Request(verification, { headers: { cookie: `__Host-claxedo.d1-auth=${written}` } }), env, context)
  expect([200, 302]).toContain(verified.status)
  expect(opened.auth.at(-1)).toBe("first-primary")

  const signedIn = await worker.fetch(new Request(`${API}/api/auth/sign-in/email`, json({ email: "ada@example.test", password: "correct-horse-battery-staple" }, `__Host-claxedo.d1-auth=${written}`)), env, context)
  expect(signedIn.status, await signedIn.clone().text()).toBe(200)
  expect(opened.auth.at(-1)).toBe("first-primary")
  const session = /__Secure-claxedo\.session_token=[^;]+/.exec(signedIn.headers.getSetCookie().join("\n"))?.[0]
  const afterSignIn = bookmark(signedIn, "auth")
  if (!session || !afterSignIn) throw new Error("sign-in set no session or no bookmark")
  expect(afterSignIn > written!).toBe(true)

  const read = await worker.fetch(new Request(`${API}/api/auth/get-session`, { headers: { origin: API, cookie: `${session}; __Host-claxedo.d1-auth=${afterSignIn}` } }), env, context)
  expect(read.status).toBe(200)
  expect(opened.auth.at(-1)).toBe(afterSignIn)
  expect(((await read.json()) as { user: { email: string } }).user.email).toBe("ada@example.test")
  expect(bookmark(read, "auth")).toBeUndefined()

  const unbookmarked = await worker.fetch(new Request(`${API}/api/auth/get-session`, { headers: { origin: API, cookie: session } }), env, context)
  expect(unbookmarked.status).toBe(200)
  expect(opened.auth.at(-1)).toBe("first-unconstrained")
  await Promise.all(readiness)
})

test("the edge hands a write to the writer before composing or authenticating anything itself, and answers a bookmarked read from its own session", async () => {
  const bound = await workerDatabases()
  active.push(bound)
  const opened = { auth: [] as string[], control: [] as string[] }
  const mail: string[] = []
  const shared = {
    CLAXEDO_D1_EDGE_READS: "on",
    CLAXEDO_AUTH_METHODS: "github,email-password",
    CLAXEDO_EMAIL_FROM: "sign-in@example.test",
    EMAIL: { send: async (message: { text: string }) => { mail.push(message.text); return { messageId: "m" } } },
  }
  const databases = { authDatabase: recording(bound.authDatabase, opened.auth), controlPlaneDatabase: recording(bound.controlPlaneDatabase, opened.control) }
  const readiness: Promise<unknown>[] = []
  const context = { waitUntil: (work: Promise<unknown>) => void readiness.push(work) } as unknown as ExecutionContext
  const composed: string[] = []
  const composing = (role: string) => settledCompositionCache((env: BetterAuthD1WorkerEnv) => {
    composed.push(role)
    return composeBetterAuthD1UserDeployedControlPlane(betterAuthD1CompositionInput(env))
  }, (created) => created.authReady)
  const writer = createBetterAuthD1Worker({ composition: composing("writer") })
  const writerEnv = betterAuthD1WorkerEnv(databases, shared)
  const edge = createBetterAuthD1Worker({ composition: composing("edge") })
  const edgeEnv = betterAuthD1WorkerEnv(databases, {
    ...shared,
    CONTROL_PLANE_WRITER: { fetch: (request: Request) => writer.fetch(request, writerEnv, context) },
  })
  const post = (path: string, body: unknown, cookie = "") => new Request(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: API, "cf-connecting-ip": "10.0.0.2", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

  const signedUp = await edge.fetch(post("/api/auth/sign-up/email", { email: "grace@example.test", password: "correct-horse-battery-staple", name: "Grace" }), edgeEnv, context)
  expect(signedUp.status, await signedUp.clone().text()).toBe(200)
  expect(composed).toEqual(["writer"])
  const timing = signedUp.headers.get("server-timing") ?? ""
  expect(timing.match(/\bauth;dur=/g)).toHaveLength(1)
  expect(timing.match(/\bcompose\b/g)).toHaveLength(1)
  expect(timing).toMatch(/forward;dur=\d+\.\d$/)
  const written = bookmark(signedUp, "auth")
  expect(opened.auth).toEqual(["first-primary"])

  const verification = mail.at(-1)?.split("\n").at(-1)
  if (!verification) throw new Error("no verification mail")
  expect([200, 302]).toContain((await edge.fetch(new Request(verification), edgeEnv, context)).status)
  expect(composed).toEqual(["writer"])
  const signedIn = await edge.fetch(post("/api/auth/sign-in/email", { email: "grace@example.test", password: "correct-horse-battery-staple" }, `__Host-claxedo.d1-auth=${written}`), edgeEnv, context)
  const session = /__Secure-claxedo\.session_token=[^;]+/.exec(signedIn.headers.getSetCookie().join("\n"))?.[0]
  const afterSignIn = bookmark(signedIn, "auth")
  if (!session || !afterSignIn) throw new Error("sign-in set no session or no bookmark")

  const read = await edge.fetch(new Request(`${API}/api/auth/get-session`, { headers: { origin: API, cookie: `${session}; __Host-claxedo.d1-auth=${afterSignIn}` } }), edgeEnv, context)
  expect(((await read.json()) as { user: { email: string } }).user.email).toBe("grace@example.test")
  expect(composed).toEqual(["writer", "edge"])
  expect(opened.auth.at(-1)).toBe(afterSignIn)
  expect(read.headers.get("server-timing")).not.toContain("forward")

  const current = await edge.fetch(new Request(`${API}/api/auth/get-session`, { headers: { origin: API, cookie: session } }), edgeEnv, context)
  const subject = ((await current.json()) as { user: { id: string } }).user.id
  const claim = generateCanonicalOwnerClaim()
  await bound.controlPlaneDatabase.prepare(ownerClaimMutationSql(await ownerClaimProvisioning({ deploymentId: "deployment-1", origin: API, subject, claim }))).run()
  const claimed = await edge.fetch(new Request(`${API}/api/claxedo/auth/bootstrap-owner`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: API, cookie: session, [USER_DEPLOYED_OWNER_CLAIM_HEADER]: claim },
    body: "{}",
  }), edgeEnv, context)
  expect(claimed.status, await claimed.clone().text()).toBe(200)

  const principalCookie = (response: Response) => response.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-claxedo.principal="))
  const signedPost = (cookie: string) => post("/api/control/session-registrations/reserve", {}, cookie)
  await Promise.all(readiness)
  const edgeComposed = composed.filter((role) => role === "edge").length
  const forwardedPost = await edge.fetch(signedPost(session), edgeEnv, context)
  const directPost = await writer.fetch(signedPost(session), writerEnv, context)
  expect(forwardedPost.status).toBe(directPost.status)
  expect(principalCookie(forwardedPost)?.split("=")[0]).toBe("__Host-claxedo.principal")
  expect(principalCookie(forwardedPost)?.split("; ").slice(1)).toEqual(principalCookie(directPost)?.split("; ").slice(1))
  expect(composed.filter((role) => role === "edge")).toHaveLength(edgeComposed)

  const profile = (cookie: string) => new Request(`${API}/api/claxedo/auth/profile`, { headers: { origin: API, cookie } })
  const verified = await edge.fetch(profile(`${session}; __Host-claxedo.d1-auth=${afterSignIn}`), edgeEnv, context)
  expect(verified.status).toBe(200)
  const cached = principalCookie(verified)?.split("; ")[0]
  if (!cached) throw new Error("a live verification on the edge issued no principal cookie")
  const authSessions = opened.auth.length
  const admitted = await edge.fetch(profile(`${session}; ${cached}`), edgeEnv, context)
  expect(admitted.status).toBe(200)
  expect(opened.auth.length, "a cached principal reads nothing from the auth database").toBe(authSessions)
  expect(admitted.headers.get("server-timing")).not.toContain("forward")

  const refused = await createBetterAuthD1Worker({ composition: composing("unreachable") }).fetch(
    post("/api/auth/sign-out", {}, session),
    betterAuthD1WorkerEnv(databases, { ...shared, CONTROL_PLANE_WRITER: { fetch: async () => { throw new Error("writer is gone") } } }),
    context,
  )
  expect(refused.status).toBe(503)
  expect(await refused.json()).toEqual({ error: { code: "deployment_candidate_unavailable" } })
  await Promise.all(readiness)
})

test("with edge reads off the one Worker reads the bare bindings: no D1 session, no bookmark cookie or header, whatever the request carries", async () => {
  const bound = await workerDatabases()
  active.push(bound)
  const opened: string[] = []
  const mail: string[] = []
  const env = betterAuthD1WorkerEnv(
    { authDatabase: recording(bound.authDatabase, opened), controlPlaneDatabase: recording(bound.controlPlaneDatabase, opened) },
    {
      CLAXEDO_AUTH_METHODS: "github,email-password",
      CLAXEDO_EMAIL_FROM: "sign-in@example.test",
      EMAIL: { send: async (message: { text: string }) => { mail.push(message.text); return { messageId: "m" } } },
    },
  )
  const readiness: Promise<unknown>[] = []
  const context = { waitUntil: (work: Promise<unknown>) => void readiness.push(work) } as unknown as ExecutionContext
  const signedUp = await worker.fetch(new Request(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: API, "cf-connecting-ip": "10.0.0.3", "x-claxedo-d1-bookmarks": "auth=00000000-00000001-00000000-00000000000000000000000000000000" },
    body: JSON.stringify({ email: "lin@example.test", password: "correct-horse-battery-staple", name: "Lin" }),
  }), env, context)
  expect(signedUp.status, await signedUp.clone().text()).toBe(200)
  const read = await worker.fetch(new Request(`${API}/api/auth/get-session`, { headers: { origin: API, cookie: "__Host-claxedo.d1-auth=00000000-00000001-00000000-00000000000000000000000000000000" } }), env, context)
  expect(read.status).toBe(200)
  for (const response of [signedUp, read]) {
    expect(bookmark(response, "auth")).toBeUndefined()
    expect(response.headers.get("x-claxedo-d1-bookmarks")).toBeNull()
    expect(response.headers.get("server-timing")).not.toContain("forward")
  }
  expect(opened).toEqual([])
  await Promise.all(readiness)
})
