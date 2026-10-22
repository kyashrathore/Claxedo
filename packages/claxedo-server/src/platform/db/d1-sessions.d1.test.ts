import { afterEach, beforeEach, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { currentD1Bookmark, echoesD1Bookmarks, inD1Scope, inD1Sessions, requestSessionD1 } from "./d1-sessions"
import { WORKERS_COMPATIBILITY_DATE } from "../../../scripts/deploy/hosted-worker-bundle"

const ORIGIN = "https://app.example.test"
const BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/

let instance: Miniflare
let raw: D1Database
let opened: unknown[]

/** The binding, recording the constraint or bookmark every session it opens starts from. */
function recording(database: D1Database): D1Database {
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

beforeEach(async () => {
  instance = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok') } }", compatibilityDate: WORKERS_COMPATIBILITY_DATE, d1Databases: ["DB"] })
  raw = await instance.getD1Database("DB")
  await raw.prepare("create table notes (id text primary key)").run()
  opened = []
})

afterEach(async () => {
  await instance.dispose()
})

function bookmarkCookies(response: Response) {
  return response.headers.getSetCookie().filter((cookie) => cookie.startsWith("__Host-claxedo.d1-"))
}

function request(method: string, cookie?: string, header?: string) {
  return new Request(`${ORIGIN}/api/notes`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(header !== undefined ? { "x-claxedo-d1-bookmarks": header } : {}) },
  })
}

test("a primary request opens its session at the primary and hands the client its bookmark in a host-only cookie", async () => {
  const database = requestSessionD1(recording(raw), "control")
  const response = await inD1Sessions(request("POST"), "primary", async () => {
    await database.prepare("insert into notes (id) values (?)").bind("first").run()
    return new Response("created", { status: 201 })
  })
  expect(opened).toEqual(["first-primary"])
  const cookies = bookmarkCookies(response)
  expect(cookies).toHaveLength(1)
  const [pair, ...attributes] = cookies[0].split("; ")
  expect(pair).toMatch(/^__Host-claxedo\.d1-control=/)
  expect(pair.slice("__Host-claxedo.d1-control=".length)).toMatch(BOOKMARK)
  expect(attributes).toEqual(["Path=/", "Max-Age=300", "Secure", "SameSite=Lax"])
  expect(response.headers.get("x-claxedo-d1-bookmarks")).toBe(`control=${pair.split("=")[1]}`)
  expect(await response.text()).toBe("created")
})

test("the next read opens its session at the bookmark the write handed back, and sees the write", async () => {
  const database = requestSessionD1(recording(raw), "control")
  const written = await inD1Sessions(request("POST"), "primary", async () => {
    await database.prepare("insert into notes (id) values (?)").bind("mine").run()
    return new Response(null, { status: 204 })
  })
  const cookie = bookmarkCookies(written)[0].split("; ")[0]
  const bookmark = cookie.split("=")[1]
  const read = await inD1Sessions(request("GET", `__Secure-claxedo.session_token=abc; ${cookie}`), "replica", async () =>
    Response.json(await database.prepare("select id from notes").all()))
  expect(opened).toEqual(["first-primary", bookmark])
  expect(((await read.json()) as { results: unknown[] }).results).toEqual([{ id: "mine" }])
  expect(bookmarkCookies(read)).toEqual([])
})

test("a read without a bookmark may start anywhere, and a write starts at the primary whatever bookmark it carries", async () => {
  const database = requestSessionD1(recording(raw), "control")
  await inD1Sessions(request("GET"), "replica", async () => Response.json(await database.prepare("select 1 as one").first()))
  const carried = "__Host-claxedo.d1-control=00000000-00000001-00000000-00000000000000000000000000000000"
  await inD1Sessions(request("DELETE", carried), "primary", async () => {
    await database.prepare("delete from notes").run()
    return new Response(null, { status: 204 })
  })
  expect(opened).toEqual(["first-unconstrained", "first-primary"])
})

test("a cookie that is not a bookmark, or names another database, is not used", async () => {
  const database = requestSessionD1(recording(raw), "control")
  for (const cookie of [
    "__Host-claxedo.d1-control=../../etc",
    "__Host-claxedo.d1-control=00000000-00000001-00000000-0000",
    "__Host-claxedo.d1-auth=00000000-00000001-00000000-00000000000000000000000000000000",
  ]) {
    await inD1Sessions(request("GET", cookie), "replica", async () => Response.json(await database.prepare("select 1 as one").first()))
  }
  expect(opened).toEqual(["first-unconstrained", "first-unconstrained", "first-unconstrained"])
})

test("each database gets one session per request, a batch runs in it, and only the databases a write touched get a cookie", async () => {
  const control = requestSessionD1(recording(raw), "control")
  const auth = requestSessionD1(recording(raw), "auth")
  const response = await inD1Sessions(request("POST"), "primary", async () => {
    await control.batch([
      control.prepare("insert into notes (id) values (?)").bind("a"),
      control.prepare("insert into notes (id) values (?)").bind("b"),
    ])
    await control.prepare("select count(*) as count from notes").first()
    return new Response(null, { status: 204 })
  })
  expect(opened).toEqual(["first-primary"])
  expect(bookmarkCookies(response).map((cookie) => cookie.split("=")[0])).toEqual(["__Host-claxedo.d1-control"])
  expect(await auth.prepare("select count(*) as count from notes").first()).toEqual({ count: 2 })
})

test("a read sets no cookie even when it writes, but names its bookmark for a client that keeps the newest; a request that ran no statement names none", async () => {
  const database = requestSessionD1(recording(raw), "control")
  const read = await inD1Sessions(request("GET"), "replica", async () => {
    await database.prepare("insert into notes (id) values ('touched')").run()
    return new Response(null, { status: 204 })
  })
  const idle = await inD1Sessions(request("POST"), "primary", async () => new Response(null, { status: 204 }))
  expect(bookmarkCookies(read)).toEqual([])
  expect(read.headers.get("x-claxedo-d1-bookmarks")).toMatch(/^control=[0-9a-f-]{59}$/)
  expect(bookmarkCookies(idle)).toEqual([])
  expect(idle.headers.get("x-claxedo-d1-bookmarks")).toBeNull()
})

test("a client without a cookie jar carries its bookmarks in the header, and the newer of header and cookie wins", async () => {
  const database = requestSessionD1(recording(raw), "control")
  const older = "00000000-00000001-00000000-00000000000000000000000000000000"
  const newer = "00000000-00000002-00000000-00000000000000000000000000000000"
  const read = (incoming: Request) => inD1Sessions(incoming, "replica", async () => Response.json(await database.prepare("select 1 as one").first()))
  await read(request("GET", undefined, `auth=${older}, control=${newer}`))
  await read(request("GET", `__Host-claxedo.d1-control=${older}`, `control=${newer}`))
  await read(request("GET", `__Host-claxedo.d1-control=${newer}`, `control=${older}`))
  await read(request("GET", undefined, "control=garbage"))
  expect(opened).toEqual([newer, newer, newer, "first-unconstrained"])
  expect(echoesD1Bookmarks(request("GET", undefined, ""))).toBe(true)
  expect(echoesD1Bookmarks(request("GET", `__Host-claxedo.d1-control=${newer}`))).toBe(false)
})

test("work that answers no request runs in a scope of its own, or joins the request it runs in, and reads the bookmark it reached", async () => {
  const database = requestSessionD1(recording(raw), "control")
  expect(currentD1Bookmark("control")).toBeUndefined()
  const reached = await inD1Scope("primary", async () => {
    expect(currentD1Bookmark("control")).toBeUndefined()
    await database.prepare("insert into notes (id) values ('alarm')").run()
    return currentD1Bookmark("control")
  })
  expect(reached).toMatch(BOOKMARK)
  expect(opened).toEqual(["first-primary"])
  await inD1Sessions(request("GET"), "replica", async () => {
    await database.prepare("select 1").first()
    await inD1Scope("primary", async () => database.prepare("select 2").first())
    return new Response(null, { status: 204 })
  })
  expect(opened).toEqual(["first-primary", "first-unconstrained"])
})

test("the cookie joins the response's own cookies, even on an answer whose headers are immutable", async () => {
  const database = requestSessionD1(recording(raw), "control")
  const response = await inD1Sessions(request("POST"), "primary", async () => {
    await database.prepare("insert into notes (id) values ('redirected')").run()
    const redirect = Response.redirect(`${ORIGIN}/`, 302)
    return redirect
  })
  expect(response.status).toBe(302)
  expect(response.headers.get("location")).toBe(`${ORIGIN}/`)
  expect(bookmarkCookies(response)).toHaveLength(1)
  const signed = await inD1Sessions(request("POST"), "primary", async () => {
    await database.prepare("insert into notes (id) values ('signed')").run()
    const answer = new Response(null, { status: 200 })
    answer.headers.append("set-cookie", "__Secure-claxedo.session_token=t; Path=/")
    return answer
  })
  expect(signed.headers.getSetCookie()[0]).toBe("__Secure-claxedo.session_token=t; Path=/")
  expect(bookmarkCookies(signed)).toHaveLength(1)
})

test("outside a request the bare binding answers, which D1 runs on the primary", async () => {
  const database = requestSessionD1(recording(raw), "control")
  await database.prepare("insert into notes (id) values ('background')").run()
  expect(await database.prepare("select id from notes").all()).toMatchObject({ results: [{ id: "background" }] })
  expect(opened).toEqual([])
})
