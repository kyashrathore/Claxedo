/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { accountQueries, createAccountsApi } from "./accounts"
import { createTransport } from "./transport"

type Seen = { readonly method: string; readonly path: string; readonly body: unknown }

const running: Array<{ stop: (force: boolean) => unknown }> = []

afterEach(() => {
  for (const server of running.splice(0)) server.stop(true)
})

function serve(answer: (request: Seen) => Response) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url)
      const text = await request.text()
      const entry = { method: request.method, path: `${url.pathname}${url.search}`, body: text ? JSON.parse(text) : undefined }
      seen.push(entry)
      return answer(entry)
    },
  })
  running.push(server)
  return { seen, transport: createTransport({ serverUrl: `http://127.0.0.1:${server.port}`, auth: { kind: "none" } }) }
}

const teamRow = { id: "cred-team", provider_id: "claude-sdk", kind: "api_key", source: "managed", label: "Acme team", scope: "shared", deliverable: { local: true, cloud: true } }

test("accounts: the person's source per provider and the organization's team rows are read, and a choice is written for every provider of the harness", async () => {
  const { seen, transport } = serve((request) => {
    if (request.path === "/api/claxedo/credentials/account-sources" && request.method === "GET") return Response.json({ sources: { "claude-sdk": "team" }, team: [teamRow], can_remove_team_accounts: false })
    return Response.json({ sources: { "claude-sdk": "own" } })
  })
  const client = new QueryClient()
  const read = accountQueries(transport).sources()
  const sources = await client.fetchQuery(read)
  expect([...sources.sources]).toEqual([["claude-sdk", "team"]])
  expect(sources.team).toEqual([expect.objectContaining({ id: "cred-team", providerId: "claude-sdk", label: "Acme team", scope: "shared" })])
  expect(sources.canRemoveTeamAccounts).toBe(false)

  await createAccountsApi(transport, client).setSource(["claude-sdk", "claude-acp"], "own")
  expect(seen.at(-1)).toEqual({ method: "PUT", path: "/api/claxedo/credentials/account-sources", body: { provider_ids: ["claude-sdk", "claude-acp"], source: "own" } })
})

test("accounts: a source answer naming anything but own or team is a contract mismatch, not an empty choice", async () => {
  const { transport } = serve(() => Response.json({ sources: { "claude-sdk": "org" }, team: [], can_remove_team_accounts: false }))
  await expect(new QueryClient().fetchQuery(accountQueries(transport).sources())).rejects.toMatchObject({ class: "internal" })
})

test("accounts: team removal is reported by the server, and an absent or malformed access fact is a contract mismatch", async () => {
  const allowed = serve(() => Response.json({ sources: {}, team: [teamRow], can_remove_team_accounts: true }))
  expect((await new QueryClient().fetchQuery(accountQueries(allowed.transport).sources())).canRemoveTeamAccounts).toBe(true)
  for (const flag of [undefined, "true", null]) {
    const invalid = serve(() => Response.json({ sources: {}, team: [teamRow], can_remove_team_accounts: flag }))
    await expect(new QueryClient().fetchQuery(accountQueries(invalid.transport).sources())).rejects.toMatchObject({ class: "internal" })
  }
})

test("accounts: the hosted plane's Pi sources are read per harness and a choice is written to the provider's source route", async () => {
  const { seen, transport } = serve((request) => {
    if (request.path === "/auth/sources?harness=pi") return Response.json({ sources: { openrouter: "team" }, team: ["openrouter", "anthropic"] })
    return Response.json({})
  })
  const client = new QueryClient()
  const hosted = await client.fetchQuery(accountQueries(transport).hostedSources("pi"))
  expect([...hosted.sources]).toEqual([["openrouter", "team"]])
  expect([...hosted.team]).toEqual(["openrouter", "anthropic"])
  await createAccountsApi(transport, client).setHostedSource("pi", "openrouter", "own")
  expect(seen.at(-1)).toEqual({ method: "PUT", path: "/auth/openrouter/source?harness=pi", body: { source: "own" } })
})

test("accounts: cloud consent writes every binding's scope and stops at the first refusal", async () => {
  const { seen, transport } = serve((request) => {
    if (request.path.endsWith("/cred-b/scope")) return Response.json({ error: { code: "credential_scope_unavailable", message: "This host keeps credentials local" } }, { status: 501 })
    return Response.json({ ok: true, scope: "shared" })
  })
  const refusal = await createAccountsApi(transport, new QueryClient()).setScope(["cred-a", "cred-b", "cred-c"], "shared").then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(seen.map((request) => `${request.method} ${request.path} ${JSON.stringify(request.body)}`)).toEqual([
    'PATCH /api/claxedo/credentials/cred-a/scope {"scope":"shared"}',
    'PATCH /api/claxedo/credentials/cred-b/scope {"scope":"shared"}',
  ])
  expect(refusal).toMatchObject({ status: 501, code: "credential_scope_unavailable", message: "This host keeps credentials local" })
})
