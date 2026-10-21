import { DurableObject } from "cloudflare:workers"
import { definePluginBackend, PluginPlatformError } from "@claxedo/plugin-api/backend"

const VERSION = "counter-v1"

export class Counter extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/name") return Response.json({ name: request.headers.get("x-claxedo-object-name") })
    if (path === "/instance") {
      this.instance ??= crypto.randomUUID()
      return Response.json({ instance: this.instance })
    }
    if (path === "/log") {
      this.ctx.storage.sql.exec("create table if not exists log (entry text not null)")
      if (request.method === "POST") this.ctx.storage.sql.exec("insert into log (entry) values (?)", await request.text())
      return Response.json(this.ctx.storage.sql.exec("select entry from log").toArray().map((row) => JSON.parse(row.entry)))
    }
    this.ctx.storage.sql.exec("create table if not exists counter (id integer primary key check (id = 1), value integer not null)")
    if (request.method === "POST") {
      this.ctx.storage.sql.exec("insert into counter (id, value) values (1, 1) on conflict (id) do update set value = value + 1")
    }
    const row = this.ctx.storage.sql.exec("select value from counter where id = 1").toArray()[0]
    return Response.json({ value: row?.value ?? 0, version: VERSION })
  }
}

async function callerOf(platform) {
  try {
    return await platform.identity.caller()
  } catch {
    return null
  }
}

async function statusOf(run) {
  try {
    await run()
    return 200
  } catch (error) {
    if (error instanceof PluginPlatformError) return error.status
    throw error
  }
}

const log = (platform) => ({
  read: () => platform.object("Counter", "wake-log", new Request("https://plugin.invalid/log")),
  write: (entry) => platform.object("Counter", "wake-log", new Request("https://plugin.invalid/log", { method: "POST", body: JSON.stringify(entry) })),
})

async function answer(request, platform) {
  const url = new URL(request.url)
  const path = url.pathname
  const segments = path.split("/").slice(1).map(decodeURIComponent)
  const text = () => request.text()
  const json = async () => {
    const body = await text()
    return body ? JSON.parse(body) : {}
  }
  if (path === "/") return Response.json({ root: true })
  if (path === "/active") return Response.json({ active: await platform.active() })
  if (path === "/count" || path === "/instance") return platform.object("Counter", "main", request)
  if (path === "/name") return platform.object("Counter", "named-object", request)
  if (path === "/whoami") {
    return Response.json({ handle: request.headers.get("x-claxedo-caller"), caller: await callerOf(platform), userIdHeader: request.headers.get("x-claxedo-user-id") })
  }
  if (path === "/public") return Response.json({ public: true, caller: await callerOf(platform) })
  if (path === "/outbound") {
    const reached = await fetch(url.searchParams.get("url") ?? "")
    return Response.json({ status: reached.status, body: await reached.json() })
  }
  if (path === "/held") {
    await fetch("https://allowed.example.com/hold")
    const active = await platform.active()
    const object = await platform.object("Counter", "main", new Request("https://plugin.invalid/count"))
    const outbound = await fetch("https://allowed.example.com/after")
    const blob = await statusOf(() => platform.blobs.head("held"))
    return Response.json({ active, object: object.status, outbound: outbound.status, caller: await callerOf(platform), blob })
  }
  if (path === "/fail") throw new Error("the counter failed")
  if (path === "/projects") return Response.json(await platform.projects.list())
  if (segments[0] === "projects" && segments[2] === "authorize") return Response.json({ allowed: await platform.projects.authorize(segments[1], segments[3]) })
  if (segments[0] === "blobs" && segments.length === 1) return Response.json(await platform.blobs.list({ prefix: url.searchParams.get("prefix") ?? undefined }))
  if (segments[0] === "blobs") {
    const key = segments.slice(1).join("/")
    if (request.method === "PUT") {
      return Response.json(await platform.blobs.put(key, new TextEncoder().encode(await text()), { contentType: request.headers.get("content-type") ?? undefined }))
    }
    if (request.method === "DELETE") return Response.json(await platform.blobs.delete(key) ?? { deleted: true })
    const blob = await platform.blobs.get(key)
    return blob ? new Response(blob.bytes, { headers: { "content-type": blob.contentType ?? "application/octet-stream" } }) : Response.json({ missing: key }, { status: 404 })
  }
  if (segments[0] === "events") return Response.json(await platform.events.publish({ audience: segments[1], ...(await json()) }))
  if (path === "/wakes/log") return log(platform).read()
  if (path === "/wakes") return Response.json(await platform.schedule.list())
  if (segments[0] === "wakes") {
    if (request.method === "DELETE") return Response.json((await platform.schedule.cancel(segments[1])) ?? { cancelled: true })
    const wake = await json()
    return Response.json((await platform.schedule.at(segments[1], wake.at, wake.payload)) ?? { scheduled: true })
  }
  if (segments[0] === "links" && request.method === "POST") return Response.json(await platform.links.create(await json()))
  if (segments[0] === "links") return Response.json((await platform.links.revoke(segments[1])) ?? { revoked: true })
  if (segments[0] === "sessions") {
    const body = await json()
    if (segments[1] === "harnesses") return Response.json(await platform.sessions.harnesses(body))
    if (segments[1] === "preview") return Response.json(await platform.sessions.preview(body))
    if (segments[1] === "start") return Response.json(await platform.sessions.start(body))
    if (segments[1] === "handoff") return Response.json(await platform.sessions.handoff(body))
    if (segments[1] === "abandon") return Response.json(await platform.sessions.abandon(body))
    if (segments[1] === "state") return Response.json(await platform.sessions.state(body.origins))
    if (segments[1] === "open") return Response.json({ allowed: await platform.sessions.authorizeOpen(body.session) })
  }
  return platform.object(segments[1] ?? "", "main", request)
}

const backend = definePluginBackend({
  async fetch(request, platform) {
    try {
      return await answer(request, platform)
    } catch (error) {
      if (error instanceof PluginPlatformError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
      throw error
    }
  },
  async wake(name, payload, platform) {
    await log(platform).write({ name, payload, caller: await callerOf(platform) })
  },
})

export default {
  async fetch(request, env) {
    // Resolves a handle another request was given, which the typed platform,
    // bound to this request's own handle, never does.
    if (new URL(request.url).pathname === "/handles/resolve") {
      const answered = await env.PLATFORM.call({ name: "identity.caller" }, await request.text())
      return Response.json({ caller: answered.ok ? answered.value : null })
    }
    return backend.fetch(request, env)
  },
}
