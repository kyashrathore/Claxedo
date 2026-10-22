import { afterEach, expect, test } from "bun:test"
import { helpText } from "./help"
import { cliCommandContext, pluginCommand } from "./plugin-commands"

const saved = {
  fetch: globalThis.fetch,
  controlPlane: process.env.CLAXEDO_CONTROL_PLANE_URL,
  token: process.env.CLAXEDO_ACCESS_TOKEN,
  home: process.env.CLAXEDO_HOME,
  log: console.log,
}

afterEach(() => {
  globalThis.fetch = saved.fetch
  console.log = saved.log
  for (const [key, value] of Object.entries({
    CLAXEDO_CONTROL_PLANE_URL: saved.controlPlane,
    CLAXEDO_ACCESS_TOKEN: saved.token,
    CLAXEDO_HOME: saved.home,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("help prints each plugin command's usage where the documents lines always stood", () => {
  expect(helpText()).toBe(`claxedo login
claxedo logout
claxedo connect [--token-file F] [--root DIR]... [--name N] [--install-service] [--uninstall-service] [--foreground] [--alongside-desktop] [--reset] [--reset-roots]
claxedo host invite --name N --root DIR... [--expires 1h]
claxedo host list
claxedo host assign --machine <name|enrollment_id> <dir> [--name N]
claxedo host unassign --machine <name|enrollment_id> <dir>
claxedo host scope --machine <name|enrollment_id> --root DIR...
claxedo host push-config --machine <name|enrollment_id> --from-file FILE
claxedo host push-config --machine <name|enrollment_id> --clear
claxedo host pause --machine <name|enrollment_id>
claxedo host resume --machine <name|enrollment_id>
claxedo host revoke --machine <name|enrollment_id>
claxedo status
claxedo doctor
claxedo whoami
claxedo documents list [--project <id> | --directory <path>]
claxedo documents open <claxedo://document/id | id | name> [--session <id>] [--project <id> | --directory <path>]
claxedo --version

\`claxedo connect --help\` and \`claxedo host --help\` describe the machine and owner sides of remote access.`)
})

test("a plugin command reaches the signed-in control plane with the CLI's own credential", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = []
  process.env.CLAXEDO_CONTROL_PLANE_URL = "https://node.example"
  process.env.CLAXEDO_ACCESS_TOKEN = "cli-token"
  process.env.CLAXEDO_HOME = "/nonexistent-claxedo-home"
  const printed: string[] = []
  console.log = (value: string) => { printed.push(value) }
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    calls.push({ url: target.href, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") })
    return Response.json([{ id: "doc_plan", display_name: "Plan", archived_at: null }])
  }) as typeof globalThis.fetch

  const documents = pluginCommand("documents")
  expect(documents).toBeDefined()
  await documents?.run(["list", "--project", "proj_1"], cliCommandContext())

  expect(calls).toEqual([
    { url: "https://node.example/documents?project_id=proj_1&archived=active", method: "GET", authorization: "Bearer cli-token" },
  ])
  expect(JSON.parse(printed[0])).toEqual([{ id: "doc_plan", display_name: "Plan", archived_at: null }])
  expect(pluginCommand("absent")).toBeUndefined()
})
