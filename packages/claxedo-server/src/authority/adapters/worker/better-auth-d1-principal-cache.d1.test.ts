import { afterAll, beforeAll, expect, test } from "vitest"
import { countD1Rounds, type D1Rounds } from "../../../test-support/d1-rounds"
import {
  USER_DEPLOYED_ORIGIN as API,
  userDeployedBetterAuthApp,
  type SignedInPerson,
  type UserDeployedBetterAuthApp,
} from "../../../test-support/user-deployed-better-auth-app"
import { BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS } from "../../../platform/auth/browser-principal-cache"

const EMAIL = "owner@principal-cache.test"
const PASSWORD = "correct-horse-battery-staple"

let rig: UserDeployedBetterAuthApp
let counted: D1Rounds
let offset = 0
let owner: SignedInPerson
let ownerUserId: string

beforeAll(async () => {
  rig = await userDeployedBetterAuthApp({
    auth: (database) => {
      counted = countD1Rounds(database, 0)
      return counted.database
    },
    controlPlane: (database) => counted.also(database),
  }, { now: () => Date.now() + offset })
  owner = await rig.signIn(EMAIL)
  await rig.claimOwnership(owner)
  ownerUserId = ((await (await rig.request("/api/claxedo/auth/profile", { headers: owner })).json()) as { user: { id: string } }).user.id
}, 60_000)

afterAll(async () => {
  await rig?.dispose()
})

function cacheCookie(response: Response) {
  return /__Host-claxedo\.principal=[^;]*/.exec(response.headers.get("set-cookie") ?? "")?.[0]
}

async function signInAgain(): Promise<SignedInPerson> {
  const response = await rig.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: API },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const cookie = /__Secure-claxedo\.session_token=[^;]+/.exec(response.headers.get("set-cookie") ?? "")?.[0]
  if (!cookie) throw new Error(`sign-in set no session cookie: ${response.status}`)
  return { cookie, origin: API }
}

/** A live verification of `person`, answering the cache its response set. */
async function cached(person: SignedInPerson) {
  const response = await rig.request("/api/claxedo/auth/profile", { headers: person })
  expect(response.status).toBe(200)
  const cache = cacheCookie(response)
  if (!cache) throw new Error("a live verification set no principal cache")
  return cache
}

async function profile(cookie: string) {
  counted.reset()
  const response = await rig.request("/api/claxedo/auth/profile", { headers: { cookie, origin: API } })
  const verified = counted.trace().some(({ sql }) => sql.startsWith('select "primary".*, "join_user"'))
  return { status: response.status, verified, cache: cacheCookie(response), body: (await response.json()) as Record<string, unknown> }
}

function sessionToken(person: SignedInPerson) {
  return decodeURIComponent(person.cookie.slice(person.cookie.indexOf("=") + 1)).split(".")[0]
}

test("the cache is set as the browser's own HTTP-only, host-only cookie for the cache's lifetime", async () => {
  const response = await rig.request("/api/claxedo/auth/profile", { headers: owner })
  const header = response.headers.get("set-cookie") ?? ""
  expect(header).toMatch(/^__Host-claxedo\.principal=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; Max-Age=60; Secure; HttpOnly; SameSite=Lax$/)
  expect(BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS).toBe(60_000)
})

test("a request carrying the cache is admitted as the same person without asking Better Auth, and sets no new cache", async () => {
  const cache = await cached(owner)
  const admitted = await profile(`${owner.cookie}; ${cache}`)
  expect(admitted).toMatchObject({ status: 200, verified: false, cache: undefined, body: { user: { id: ownerUserId } } })
})

test("an expired cache is verified live and replaced", async () => {
  const cache = await cached(owner)
  offset += BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS
  try {
    const expired = await profile(`${owner.cookie}; ${cache}`)
    expect(expired).toMatchObject({ status: 200, verified: true, body: { user: { id: ownerUserId } } })
    expect(expired.cache).toBeDefined()
    expect(expired.cache).not.toBe(cache)
  } finally {
    offset = 0
  }
})

test("a session revoked elsewhere is admitted on its cache for at most the cache's lifetime, then refused", async () => {
  const person = await signInAgain()
  const cache = await cached(person)
  await rig.authDatabase.prepare(`delete from "session" where "token" = ?`).bind(sessionToken(person)).run()
  offset = BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS - 1_000
  try {
    expect(await profile(`${person.cookie}; ${cache}`)).toMatchObject({ status: 200, verified: false })
    offset = BROWSER_PRINCIPAL_CACHE_MAX_AGE_MS
    expect(await profile(`${person.cookie}; ${cache}`)).toMatchObject({ status: 401, verified: true, cache: undefined })
  } finally {
    offset = 0
  }
})

test("sign-out clears the cache with the session cookie, and the cache alone signs nobody in", async () => {
  const person = await signInAgain()
  const cache = await cached(person)
  const signedOut = await rig.request("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json", origin: API, cookie: `${person.cookie}; ${cache}` },
    body: "{}",
  })
  expect(signedOut.status).toBe(200)
  const cookies = signedOut.headers.getSetCookie()
  expect(cookies).toContain("__Host-claxedo.principal=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax")
  expect(cookies.some((cookie) => /^__Secure-claxedo\.session_token=;.*Max-Age=0/.test(cookie))).toBe(true)
  expect(await profile(cache)).toMatchObject({ status: 401 })
  expect(await profile(`${person.cookie}; ${cache}`)).toMatchObject({ status: 200, verified: false })
})

test("a cache is spent only beside the session cookie it was issued for", async () => {
  const first = await signInAgain()
  const second = await signInAgain()
  const firstCache = await cached(first)
  await rig.authDatabase.prepare(`delete from "session" where "token" = ?`).bind(sessionToken(second)).run()
  expect(await profile(`${second.cookie}; ${firstCache}`)).toMatchObject({ status: 401, verified: true })
  expect(await profile(`${first.cookie}; ${firstCache}`)).toMatchObject({ status: 200, verified: false })
})

test("a tampered cache is not used: the request is verified live, and a revoked session is refused", async () => {
  const person = await signInAgain()
  const cache = await cached(person)
  const [name, value] = [cache.slice(0, cache.indexOf("=")), cache.slice(cache.indexOf("=") + 1)]
  const [body, signature] = value.split(".") as [string, string]
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>
  const forged = Buffer.from(JSON.stringify({ ...claims, expiresAt: Date.now() + 3_600_000 })).toString("base64url")
  await rig.authDatabase.prepare(`delete from "session" where "token" = ?`).bind(sessionToken(person)).run()
  for (const tampered of [`${name}=${forged}.${signature}`, `${name}=${body}.${signature.slice(1)}A`, `${name}=${body}`]) {
    expect(await profile(`${person.cookie}; ${tampered}`)).toMatchObject({ status: 401, verified: true })
  }
  expect(await profile(`${person.cookie}; ${cache}`)).toMatchObject({ status: 200, verified: false })
})

test("authorization still reads live: a suspended person is refused on a request their cache admits", async () => {
  const cache = await cached(owner)
  await rig.controlPlaneDatabase.prepare(`update users set state = 'suspended', suspended_at = ? where user_id = ?`).bind(Date.now(), ownerUserId).run()
  try {
    const refused = await profile(`${owner.cookie}; ${cache}`)
    expect(refused).toMatchObject({ status: 403, verified: false, body: { error: { code: "account_suspended" } } })
  } finally {
    await rig.controlPlaneDatabase.prepare(`update users set state = 'active', suspended_at = null where user_id = ?`).bind(ownerUserId).run()
  }
})
