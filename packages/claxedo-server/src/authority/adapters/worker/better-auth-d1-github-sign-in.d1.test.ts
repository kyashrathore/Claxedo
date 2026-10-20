import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { countD1Rounds, type D1Rounds } from "../../../test-support/d1-rounds"
import { retireExpiredVerifications } from "../../../platform/auth/better-auth-d1-foundation"
import { USER_DEPLOYED_ORIGIN as APP, userDeployedBetterAuthApp, type UserDeployedBetterAuthApp } from "../../../test-support/user-deployed-better-auth-app"

/**
 * GitHub's side of a sign-in, scripted: the token exchange answers a token,
 * and the profile and address reads each take `GITHUB_MS`, recording when
 * they started and ended so a test can tell reads that overlapped from reads
 * made one after the other.
 */
const GITHUB_MS = 40
const calls: Array<{ url: string; started: number; ended: number }> = []

async function github(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input)
  const started = performance.now()
  await new Promise((resolve) => setTimeout(resolve, GITHUB_MS))
  calls.push({ url: `${url.host}${url.pathname}`, started, ended: performance.now() })
  if (url.href === "https://github.com/login/oauth/access_token") {
    expect(new URLSearchParams(String(init?.body)).get("code")).toBe("granted")
    return Response.json({ access_token: "gho_granted", token_type: "bearer", scope: "read:user,user:email" })
  }
  if (url.href === "https://api.github.com/user") return Response.json({ id: 4242, login: "octo", name: "Octo Cat", email: null, avatar_url: "https://avatars.example.test/octo" })
  if (url.href === "https://api.github.com/user/emails") return Response.json([{ email: "octo@example.test", primary: true, verified: true }])
  return new Response("unexpected", { status: 500 })
}

let rig: UserDeployedBetterAuthApp
let counted: D1Rounds

beforeAll(async () => {
  rig = await userDeployedBetterAuthApp({
    auth: (database) => {
      counted = countD1Rounds(database)
      return counted.database
    },
  }, { github: github as typeof fetch })
}, 60_000)

afterAll(async () => {
  await rig?.dispose()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The browser's whole sign-in: the start, GitHub's consent elsewhere, then its redirect back to the callback. */
async function signInWithGitHub() {
  vi.stubGlobal("fetch", github)
  const started = await rig.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", origin: APP },
    body: JSON.stringify({ provider: "github", callbackURL: `${APP}/` }),
  })
  expect(started.status, await started.clone().text()).toBe(200)
  const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state")
  const cookie = /__Secure-claxedo\.state=[^;]+/.exec(started.headers.get("set-cookie") ?? "")?.[0]
  if (!state || !cookie) throw new Error("the sign-in start set no state")
  calls.length = 0
  counted.reset()
  const landed = await rig.request(`/api/auth/callback/github?code=granted&state=${encodeURIComponent(state)}`, { headers: { cookie } })
  return { landed, rounds: counted.rounds(), statements: counted.trace().map((entry) => entry.sql) }
}

test("a returning person's GitHub callback signs them in in six auth-database rounds and two GitHub rounds", async () => {
  const first = await signInWithGitHub()
  expect(first.landed.status).toBe(302)
  expect(first.landed.headers.get("location")).toBe(`${APP}/`)
  const again = await signInWithGitHub()
  expect(again.landed.status).toBe(302)
  expect(again.landed.headers.get("set-cookie")).toMatch(/__Secure-claxedo\.session_token=/)
  expect(again.statements.some((sql) => sql.includes(`"expiresAt" <`)), "expired verification rows are retired after the response").toBe(false)
  expect(again.statements.some((sql) => /^update "account"/.test(sql)), "the provider's tokens are not written back").toBe(false)
  expect(again.rounds).toBe(6)
  const reads = calls.filter((call) => call.url.startsWith("api.github.com"))
  expect(reads.map((call) => call.url).sort()).toEqual(["api.github.com/user", "api.github.com/user/emails"])
  expect(Math.max(...reads.map((call) => call.started)), "the profile and the addresses are asked together").toBeLessThan(Math.min(...reads.map((call) => call.ended)))
})

test("the person GitHub names is the one signed in, with the primary verified address", async () => {
  const { landed } = await signInWithGitHub()
  const cookie = /__Secure-claxedo\.session_token=[^;]+/.exec(landed.headers.get("set-cookie") ?? "")?.[0]
  const session = (await (await rig.request("/api/auth/get-session", { headers: { cookie: cookie ?? "" } })).json()) as { user: { email: string; name: string; emailVerified: boolean } }
  expect(session.user).toMatchObject({ email: "octo@example.test", name: "Octo Cat", emailVerified: true })
})

test("retiring expired verifications deletes exactly the rows past their expiry", async () => {
  const now = Date.now()
  const insert = (id: string, expiresAt: number) =>
    rig.authDatabase.prepare(`insert into "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") values (?, ?, '{}', ?, ?, ?)`)
      .bind(id, `identifier-${id}`, new Date(expiresAt).toISOString(), new Date(now).toISOString(), new Date(now).toISOString()).run()
  await insert("expired", now - 1_000)
  await insert("live", now + 600_000)
  await retireExpiredVerifications(rig.authDatabase, now)
  const left = await rig.authDatabase.prepare(`select "id" from "verification" where "id" in ('expired', 'live')`).all<{ id: string }>()
  expect(left.results.map((row) => row.id)).toEqual(["live"])
})
