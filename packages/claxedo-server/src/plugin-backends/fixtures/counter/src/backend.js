import { DurableObject } from "cloudflare:workers"

const VERSION = "counter-v1"

export class Counter extends DurableObject {
  async fetch(request) {
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
    if (url.pathname === "/count") return env.OBJECTS.object("Counter", "main", request)
    if (url.pathname === "/whoami") return Response.json({ userId: request.headers.get("x-claxedo-user-id") })
    if (url.pathname === "/outbound") {
      const answer = await fetch(url.searchParams.get("url") ?? "")
      return Response.json({ status: answer.status, body: await answer.json() })
    }
    if (url.pathname === "/fail") throw new Error("the counter failed")
    return env.OBJECTS.object(url.pathname.split("/")[2] ?? "", "main", request)
  },
}
