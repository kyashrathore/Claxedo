import { afterEach, expect, test } from "bun:test"
import type { CliCommandContext } from "@claxedo/plugin-api/cli"
import { documentsCliCommand } from "./command"

type Call = { url: string; method: string; body?: unknown; token: string }

const ROWS = [
  { id: "doc_plan", project_id: "proj_1", display_name: "Plan", archived_at: null },
  { id: "doc_old", project_id: "proj_1", display_name: "Old", archived_at: 1 },
]

const log = console.log

afterEach(() => {
  console.log = log
})

/** The documents service behind the CLI's request path, which throws a refusal's own message as the CLI's does. */
function serve(input: { rows?: readonly Record<string, unknown>[]; viewOnly?: readonly string[]; env?: Record<string, string> } = {}) {
  const rows = input.rows ?? ROWS
  const calls: Call[] = []
  const printed: string[] = []
  console.log = (value: string) => { printed.push(value) }
  const context: CliCommandContext = {
    controlPlaneUrl: () => "https://node.example",
    url: (base, path) => new URL(path.replace(/^\/+/, ""), `${base}/`).toString(),
    requireAccessToken: async () => "cli-token",
    env: input.env ?? {},
    async requestJson(request) {
      const target = new URL(request.url)
      calls.push({
        url: `${target.pathname}${target.search}`,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
        token: request.token,
      })
      if (target.pathname === "/documents") {
        const archived = target.searchParams.get("archived")
        return rows.filter((row) => archived === "all" || !row.archived_at)
      }
      const open = /^\/documents\/([^/]+)\/agent-open$/.exec(target.pathname)
      if (open && input.viewOnly?.includes(open[1])) throw new Error("Document not found")
      if (open) return { document_id: open[1], display_name: "Plan", path: `/data/documents/${open[1]}/plan.md` }
      throw new Error(target.pathname)
    },
  }
  return { calls, printed, run: (args: readonly string[]) => documentsCliCommand.run(args, context) }
}

test("documents list prints the project's active documents", async () => {
  const service = serve()
  await service.run(["list", "--project", "proj_1"])
  expect(service.calls).toEqual([
    { url: "/documents?project_id=proj_1&archived=active", method: "GET", token: "cli-token" },
  ])
  expect(JSON.parse(service.printed[0])).toEqual([{ id: "doc_plan", project_id: "proj_1", display_name: "Plan", archived_at: null }])
})

test("documents list scopes to the working directory when no project is named", async () => {
  const service = serve()
  await service.run(["list"])
  expect(service.calls[0].url).toBe(`/documents?directory=${encodeURIComponent(process.cwd())}&archived=active`)
})

test("documents open resolves a reference and prints the path the service granted", async () => {
  const service = serve()
  await service.run(["open", "claxedo://document/doc_plan", "--project", "proj_1", "--session", "ses_1"])
  expect(service.calls[1]).toEqual({
    url: "/documents/doc_plan/agent-open",
    method: "POST",
    body: { session_id: "ses_1" },
    token: "cli-token",
  })
  expect(service.printed).toEqual(["/data/documents/doc_plan/plan.md"])
})

test("documents open takes the session from the environment a Claxedo terminal sets", async () => {
  const service = serve({ env: { CLAXEDO_SESSION_ID: "ses_env" } })
  await service.run(["open", "Plan", "--project", "proj_1"])
  expect(service.calls[1].body).toEqual({ session_id: "ses_env" })
})

test("documents open surfaces the service's refusal for a page this caller may read but not edit", async () => {
  const service = serve({ viewOnly: ["doc_plan"] })
  await expect(service.run(["open", "doc_plan", "--project", "proj_1", "--session", "ses_1"])).rejects.toThrow("Document not found")
  expect(service.printed).toEqual([])
})

test("documents open refuses an archived document, an unknown one, and a call with no session", async () => {
  const service = serve()
  await expect(service.run(["open", "doc_old", "--project", "proj_1", "--session", "ses_1"])).rejects.toThrow("is archived")
  await expect(service.run(["open", "absent", "--project", "proj_1", "--session", "ses_1"])).rejects.toThrow("No document 'absent'")
  await expect(service.run(["open", "doc_plan", "--project", "proj_1"])).rejects.toThrow("--session")
})

test("documents refuses two scopes, an unknown subcommand and a flag with no value", async () => {
  const service = serve()
  await expect(service.run(["list", "--project", "proj_1", "--directory", "/w"])).rejects.toThrow("not both")
  await expect(service.run(["archive", "--project", "proj_1"])).rejects.toThrow("Unknown documents command")
  await expect(service.run(["list", "--project"])).rejects.toThrow("needs a value")
})
