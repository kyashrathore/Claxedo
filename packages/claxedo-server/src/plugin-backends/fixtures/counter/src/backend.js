import { DurableObject } from "cloudflare:workers"

const VERSION = "counter-v1"

export class Counter extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/instance") {
      this.instance ??= crypto.randomUUID()
      return Response.json({ instance: this.instance })
    }
    this.ctx.storage.sql.exec("create table if not exists counter (id integer primary key check (id = 1), value integer not null)")
    if (request.method === "POST") {
      this.ctx.storage.sql.exec("insert into counter (id, value) values (1, 1) on conflict (id) do update set value = value + 1")
    }
    const row = this.ctx.storage.sql.exec("select value from counter where id = 1").toArray()[0]
    return Response.json({ value: row?.value ?? 0, version: VERSION })
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === "/") return Response.json({ root: true })
    if (url.pathname === "/active") return Response.json({ active: await env.PLATFORM.active() })
    if (url.pathname === "/count" || url.pathname === "/instance") return env.PLATFORM.object("Counter", "main", request)
    if (url.pathname === "/whoami") return Response.json({ userId: request.headers.get("x-claxedo-user-id") })
    if (url.pathname === "/outbound") {
      const answer = await fetch(url.searchParams.get("url") ?? "")
      return Response.json({ status: answer.status, body: await answer.json() })
    }
    if (url.pathname === "/held") {
      await fetch("https://allowed.example.com/hold")
      const active = await env.PLATFORM.active()
      const object = await env.PLATFORM.object("Counter", "main", new Request("https://plugin.invalid/count"))
      const outbound = await fetch("https://allowed.example.com/after")
      return Response.json({ active, object: object.status, outbound: outbound.status })
    }
    if (url.pathname === "/fail") throw new Error("the counter failed")
    return env.PLATFORM.object(url.pathname.split("/")[2] ?? "", "main", request)
  },
}
