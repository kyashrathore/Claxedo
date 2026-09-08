import { afterEach, expect, test } from "bun:test"
import { documents } from "./documents"

type Call = { url: string; method: string; body?: unknown; token?: string }

const saved = {
  fetch: globalThis.fetch,
  controlPlane: process.env.CLAXEDO_CONTROL_PLANE_URL,
  token: process.env.CLAXEDO_ACCESS_TOKEN,
  session: process.env.CLAXEDO_SESSION_ID,
  home: process.env.CLAXEDO_HOME,
  log: console.log,
}

const ROWS = [
  { id: "doc_plan", project_id: "proj_1", display_name: "Plan", archived_at: null },
  { id: "doc_old", project_id: "proj_1", display_name: "Old", archived_at: 1 },
]

/** The documents service, and the CLI's own credential file kept out of the way. */
function serve(rows: readonly Record<string, unknown>[] = ROWS) {
  const calls: Call[] = []
  const printed: string[] = []
  process.env.CLAXEDO_CONTROL_PLANE_URL = "https://node.example"
  process.env.CLAXEDO_ACCESS_TOKEN = "cli-token"
  process.env.CLAXEDO_HOME = "/nonexistent-claxedo-home"
  console.log = (value: string) => { printed.push(value) }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push({
      url: `${target.pathname}${target.search}`,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      ...(new Headers(init?.headers).get("authorization") ? { token: new Headers(init?.headers).get("authorization") ?? undefined } : {}),
    })
    if (target.pathname === "/documents") {
      const archived = target.searchParams.get("archived")
      return Response.json(rows.filter((row) => archived === "all" || !row.archived_at))
    }
    const open = /^\/documents\/([^/]+)\/agent-open$/.exec(target.pathname)
    if (open) return Response.json({ document_id: open[1], display_name: "Plan", path: `/data/documents/${open[1]}/plan.md` })
    return Response.json({ error: { code: "not_found", message: target.pathname } }, { status: 404 })
  }) as typeof globalThis.fetch
  return { calls, printed }
}

afterEach(() => {
  globalThis.fetch = saved.fetch
  console.log = saved.log
  for (const [key, value] of Object.entries({
    CLAXEDO_CONTROL_PLANE_URL: saved.controlPlane,
    CLAXEDO_ACCESS_TOKEN: saved.token,
    CLAXEDO_SESSION_ID: saved.session,
    CLAXEDO_HOME: saved.home,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("documents list prints the project's active documents", async () => {
  const service = serve()
  await documents(["list", "--project", "proj_1"])
  expect(service.calls).toEqual([
    { url: "/documents?project_id=proj_1&archived=active", method: "GET", token: "Bearer cli-token" },
  ])
  expect(JSON.parse(service.printed[0])).toEqual([{ id: "doc_plan", project_id: "proj_1", display_name: "Plan", archived_at: null }])
})

test("documents list scopes to the working directory when no project is named", async () => {
  const service = serve()
  await documents(["list"])
  expect(service.calls[0].url).toBe(`/documents?directory=${encodeURIComponent(process.cwd())}&archived=active`)
})

test("documents open resolves a reference and prints the path the service granted", async () => {
  const service = serve()
  await documents(["open", "claxedo://document/doc_plan", "--project", "proj_1", "--session", "ses_1"])
  expect(service.calls[1]).toEqual({
    url: "/documents/doc_plan/agent-open",
    method: "POST",
    body: { session_id: "ses_1" },
    token: "Bearer cli-token",
  })
  expect(service.printed).toEqual(["/data/documents/doc_plan/plan.md"])
})

test("documents open takes the session from the environment a Claxedo terminal sets", async () => {
  const service = serve()
  process.env.CLAXEDO_SESSION_ID = "ses_env"
  await documents(["open", "Plan", "--project", "proj_1"])
  expect(service.calls[1].body).toEqual({ session_id: "ses_env" })
})

test("documents open refuses an archived document, an unknown one, and a call with no session", async () => {
  serve()
  delete process.env.CLAXEDO_SESSION_ID
  await expect(documents(["open", "doc_old", "--project", "proj_1", "--session", "ses_1"])).rejects.toThrow("is archived")
  await expect(documents(["open", "absent", "--project", "proj_1", "--session", "ses_1"])).rejects.toThrow("No document 'absent'")
  await expect(documents(["open", "doc_plan", "--project", "proj_1"])).rejects.toThrow("--session")
})

test("documents refuses two scopes, an unknown subcommand and a flag with no value", async () => {
  serve()
  await expect(documents(["list", "--project", "proj_1", "--directory", "/w"])).rejects.toThrow("not both")
  await expect(documents(["archive", "--project", "proj_1"])).rejects.toThrow("Unknown documents command")
  await expect(documents(["list", "--project"])).rejects.toThrow("needs a value")
})
