/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createHostedAccount } from "./account"
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
  return { seen, transport: createTransport({ serverUrl: `http://127.0.0.1:${server.port}` }) }
}

const orgRow = { id: "cred-org", provider_id: "claude-sdk", kind: "api_key", source: "managed", label: "Acme", scope: "shared", deliverable: { local: true, cloud: true } }

test("accounts: the person's source per provider and the organization's own rows are read, and a choice is written for every provider of the harness", async () => {
  const { seen, transport } = serve((request) => {
    if (request.path === "/api/claxedo/credentials/account-sources" && request.method === "GET") return Response.json({ sources: { "claude-sdk": "org" }, org: [orgRow], can_manage_org_accounts: false })
    return Response.json({ sources: { "claude-sdk": "own" } })
  })
  const client = new QueryClient()
  const read = accountQueries(transport, undefined).sources()
  const sources = await client.fetchQuery(read)
  expect([...sources.sources]).toEqual([["claude-sdk", "org"]])
  expect(sources.org).toEqual([expect.objectContaining({ id: "cred-org", providerId: "claude-sdk", label: "Acme", scope: "shared" })])
  expect(sources.canManageOrgAccounts).toBe(false)

  await createAccountsApi(transport, client, undefined).setSource(["claude-sdk", "claude-acp"], "own")
  expect(seen.at(-1)).toEqual({ method: "PUT", path: "/api/claxedo/credentials/account-sources", body: { provider_ids: ["claude-sdk", "claude-acp"], source: "own" } })
})

test("accounts: a source answer naming anything but own or org is a contract mismatch, not an empty choice", async () => {
  const { transport } = serve(() => Response.json({ sources: { "claude-sdk": "team" }, org: [], can_manage_org_accounts: false }))
  await expect(new QueryClient().fetchQuery(accountQueries(transport, undefined).sources())).rejects.toMatchObject({ class: "internal" })
})

test("accounts: a team account is saved as the organization's API key, and the server's refusal of a plan comes back in its words", async () => {
  const { seen, transport } = serve((request) => {
    const body = request.body as { secret?: string }
    if (body.secret?.startsWith("sk-ant-oat")) {
      return Response.json({ error: { code: "org_account_plan_refused", message: "Team accounts hold API keys only." } }, { status: 400 })
    }
    return Response.json({ credential: { id: "cred-team", provider_id: "anthropic", kind: "api_key", source: "managed", label: "Team", owner: null } })
  })
  const api = createAccountsApi(transport, new QueryClient(), undefined)
  expect(await api.saveOrgAccount("anthropic", " sk-ant-api03-team ", "Team")).toMatchObject({ id: "cred-team", providerId: "anthropic", label: "Team" })
  expect(seen.at(-1)).toEqual({
    method: "PUT",
    path: "/api/claxedo/credentials",
    body: { provider_id: "anthropic", kind: "api_key", source: "managed", owner: "org", label: "Team", secret: " sk-ant-api03-team " },
  })
  await expect(api.saveOrgAccount("anthropic", "sk-ant-oat01-plan", "")).rejects.toMatchObject({ code: "org_account_plan_refused", message: "Team accounts hold API keys only." })
  expect(seen.at(-1)?.body).toEqual({ provider_id: "anthropic", kind: "api_key", source: "managed", owner: "org", secret: "sk-ant-oat01-plan" })
})

test("accounts: org account removal is reported by the server, and an absent or malformed access fact is a contract mismatch", async () => {
  const allowed = serve(() => Response.json({ sources: {}, org: [orgRow], can_manage_org_accounts: true }))
  expect((await new QueryClient().fetchQuery(accountQueries(allowed.transport, undefined).sources())).canManageOrgAccounts).toBe(true)
  for (const flag of [undefined, "true", null]) {
    const invalid = serve(() => Response.json({ sources: {}, org: [orgRow], can_manage_org_accounts: flag }))
    await expect(new QueryClient().fetchQuery(accountQueries(invalid.transport, undefined).sources())).rejects.toMatchObject({ class: "internal" })
  }
})


test("accounts: cloud consent writes every binding's scope and stops at the first refusal", async () => {
  const { seen, transport } = serve((request) => {
    if (request.path.endsWith("/cred-b/scope")) return Response.json({ error: { code: "credential_scope_unavailable", message: "This host keeps credentials local" } }, { status: 501 })
    return Response.json({ ok: true, scope: "shared" })
  })
  const refusal = await createAccountsApi(transport, new QueryClient(), undefined).setScope(["cred-a", "cred-b", "cred-c"], "shared").then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(seen.map((request) => `${request.method} ${request.path} ${JSON.stringify(request.body)}`)).toEqual([
    'PATCH /api/claxedo/credentials/cred-a/scope {"scope":"shared"}',
    'PATCH /api/claxedo/credentials/cred-b/scope {"scope":"shared"}',
  ])
  expect(refusal).toMatchObject({ status: 501, code: "credential_scope_unavailable", message: "This host keeps credentials local" })
})

test("accounts: a refresh rereads the stored accounts and scans no machine", async () => {
  const { seen, transport } = serve(() => Response.json({ credentials: [] }))
  const client = new QueryClient()
  const read = accountQueries(transport, undefined).list()
  await client.fetchQuery(read)
  await createAccountsApi(transport, client, undefined).refresh()
  expect(client.getQueryState(read.queryKey)?.isInvalidated).toBe(true)
  await client.fetchQuery(read)
  expect(seen.map((request) => request.path)).toEqual(["/api/claxedo/credentials", "/api/claxedo/credentials"])
})

test("accounts: a refused removal rereads the accounts, so a row another tab already removed corrects itself", async () => {
  const { transport } = serve(() => Response.json({ error: { code: "credential_not_found", message: "No such account" } }, { status: 404 }))
  const client = new QueryClient()
  const read = accountQueries(transport, undefined).list()
  client.setQueryData(read.queryKey, [])
  await expect(createAccountsApi(transport, client, undefined).remove(["gone"])).rejects.toMatchObject({ class: "not_found" })
  expect(client.getQueryState(read.queryKey)?.isInvalidated).toBe(true)
})

test("accounts: a Check of a provider Claxedo has no check for answers uncheckable, not a verdict", async () => {
  const { seen, transport } = serve(() => Response.json({ result: "uncheckable" }))
  const api = createAccountsApi(transport, new QueryClient(), undefined)

  await expect(api.check("cred-groq")).resolves.toEqual({ uncheckable: true })
  expect(seen.map((request) => `${request.method} ${request.path}`)).toContain("POST /api/claxedo/credentials/cred-groq/verify")
})

function hostedAccount(answer: (operation: string, input: Readonly<Record<string, unknown>> | undefined) => unknown) {
  const calls: Array<{ readonly operation: string; readonly input?: Readonly<Record<string, unknown>> }> = []
  const account = createHostedAccount(async (operation, input) => {
    calls.push({ operation, ...(input ? { input } : {}) })
    return answer(operation, input)
  })
  return { account, calls }
}

const sandboxListing = { drivers: [{ id: "modal", label: "Modal", fields: [{ key: "token", label: "Token", secret: true }] }], keys: [{ ...orgRow, id: "cred-sandbox", provider_id: "modal", kind: "sandbox_driver" }], default_driver: "modal", machine_classes: ["default"], can_manage: true }

test("accounts: with a hosted account the organization's facts are the account's, and the connected server is never asked for them", async () => {
  const { seen, transport } = serve(() => Response.json({ error: { code: "unexpected", message: "the connected server was asked" } }, { status: 500 }))
  const { account, calls } = hostedAccount((operation) => {
    if (operation === "credentials.sources.read") return { sources: { "claude-sdk": "org" }, org: [orgRow], can_manage_org_accounts: true }
    if (operation === "credentials.sandbox.read") return sandboxListing
    if (operation === "credentials.save") return { credential: { ...orgRow, id: "cred-saved", provider_id: "anthropic" } }
    return {}
  })
  const client = new QueryClient()
  const queries = accountQueries(transport, account)
  const sources = await client.fetchQuery(queries.sources())
  expect(sources.org).toEqual([expect.objectContaining({ id: "cred-org" })])
  expect(sources.canManageOrgAccounts).toBe(true)
  const sandbox = await client.fetchQuery(queries.sandbox())
  expect(sandbox).toMatchObject({ kind: "listed", defaultDriver: "modal", canManage: true, keys: [expect.objectContaining({ id: "cred-sandbox" })] })
  const api = createAccountsApi(transport, client, account)
  await api.setSource(["claude-sdk", "claude-acp"], "org")
  await api.chooseSandboxDriver(null)
  expect(await api.saveOrgAccount("anthropic", "sk-ant-api03-team", "Team")).toMatchObject({ id: "cred-saved" })
  expect(await api.saveSandboxKey("modal", { token: "mo-1" })).toMatchObject({ id: "cred-saved" })
  expect(calls.map((call) => call.operation)).toEqual([
    "credentials.sources.read",
    "credentials.sandbox.read",
    "credentials.sources.set",
    "credentials.sandbox.choose",
    "credentials.save",
    "credentials.save",
  ])
  expect(calls[2]?.input).toEqual({ provider_ids: ["claude-sdk", "claude-acp"], source: "org" })
  expect(calls[3]?.input).toEqual({ driver: null })
  expect(calls[4]?.input).toEqual({ provider_id: "anthropic", kind: "api_key", source: "managed", owner: "org", label: "Team", secret: "sk-ant-api03-team" })
  expect(calls[5]?.input).toEqual({ provider_id: "modal", kind: "sandbox_driver", source: "managed", secret: JSON.stringify({ token: "mo-1" }) })
  expect(seen).toEqual([])
})

test("accounts: a check or removal goes to the plane whose listing named the row: the hosted account for its organization's and sandbox rows, the connected server for every other", async () => {
  const { seen, transport } = serve((request) => (request.path.endsWith("/verify") ? Response.json({ result: "ok" }) : Response.json({ deleted: true })))
  const { account, calls } = hostedAccount((operation) => {
    if (operation === "credentials.sources.read") return { sources: {}, org: [orgRow], can_manage_org_accounts: true }
    if (operation === "credentials.sandbox.read") return sandboxListing
    if (operation === "credentials.verify") return { result: "auth_failed" }
    return { deleted: true }
  })
  const client = new QueryClient()
  const queries = accountQueries(transport, account)
  await client.fetchQuery(queries.sources())
  await client.fetchQuery(queries.sandbox())
  const api = createAccountsApi(transport, client, account)
  expect(await api.check("cred-org")).toEqual({ verdict: "auth_failed" })
  expect(await api.check("cred-local")).toEqual({ verdict: "ok" })
  await api.remove(["cred-sandbox", "cred-local"])
  expect(calls.filter((call) => call.operation === "credentials.verify" || call.operation === "credentials.remove")).toEqual([
    { operation: "credentials.verify", input: { id: "cred-org" } },
    { operation: "credentials.remove", input: { id: "cred-sandbox" } },
  ])
  expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual(["POST /api/claxedo/credentials/cred-local/verify", "DELETE /api/claxedo/credentials/cred-local"])
})

test("accounts: a hosted plane that keeps no sandbox keys answers unsupported through the account as it does on the wire", async () => {
  const { transport } = serve(() => Response.json({}))
  const { account } = hostedAccount(() => {
    throw new Error('HOSTED_HTTP 501 {"body":{"error":{"code":"sandbox_keys_unavailable","message":"This host keeps no sandbox keys"}}}')
  })
  expect(await new QueryClient().fetchQuery(accountQueries(transport, account).sandbox())).toEqual({ kind: "unsupported" })
})

test("accounts: without a hosted account the organization's facts are the connected server's, as before", async () => {
  const { seen, transport } = serve(() => Response.json({ sources: {}, org: [], can_manage_org_accounts: false }))
  await new QueryClient().fetchQuery(accountQueries(transport, undefined).sources())
  expect(seen.map((request) => request.path)).toEqual(["/api/claxedo/credentials/account-sources"])
})
