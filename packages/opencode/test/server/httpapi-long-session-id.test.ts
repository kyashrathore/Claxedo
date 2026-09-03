import { afterEach, describe, expect, test } from "bun:test"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function call(method: string, route: string, directory: string, body?: unknown) {
  return HttpApiApp.webHandler().handler(
    new Request(new URL(`http://localhost${route}`), {
      method,
      headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    context,
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("long session ids", () => {
  // A run's session id is derived from a run id that embeds the owner,
  // operation, and work-item ids, so real ids run to ~250 characters. The
  // router's default `maxParamLength` of 100 used to drop those on the floor
  // with a bare 404 — after a `POST /api/session` that had happily returned
  // 200 — which read as a vanished session rather than a rejected URL.
  test("route to their session instead of a router 404", async () => {
    await using tmp = await tmpdir({ git: true })
    const id = `ses_run_${"w".repeat(200)}_task`
    expect(id.length).toBeGreaterThan(100)

    const created = await call("POST", "/api/session", tmp.path, { id, title: "long id" })
    expect(created.status).toBe(200)

    const history = await call("GET", `/api/session/${id}/history`, tmp.path)
    expect(history.status).toBe(200)

    const interrupt = await call("POST", `/api/session/${id}/interrupt`, tmp.path)
    expect(interrupt.status).toBeLessThan(300)
  })

  // The bare router 404 carries no body, so a test asserting only the status
  // would pass just as well against the bug. An absent session must still come
  // back through the handler as a structured error.
  test("still report an absent session through the handler", async () => {
    await using tmp = await tmpdir({ git: true })
    const missing = `ses_wgrun_run_${"m".repeat(200)}_task`

    const history = await call("GET", `/api/session/${missing}/history`, tmp.path)
    expect(history.status).toBe(404)
    expect(history.headers.get("content-type")).toContain("application/json")
    expect((await history.text()).length).toBeGreaterThan(0)
  })
})
