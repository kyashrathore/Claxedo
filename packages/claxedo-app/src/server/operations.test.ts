import { describe, expect, test } from "bun:test"
import { createHostedAccount } from "./account"
import { createOperations, hostedOperationRequest } from "./operations"
import type { Transport } from "./transport"

describe("hosted operations over the connected server's routes", () => {
  test("only declared body fields reach the server", async () => {
    const requests: RequestInit[] = []
    const transport = { json: async (_path: string, init: RequestInit) => (requests.push(init), {}) } as unknown as Transport
    await createOperations(transport, undefined).run("documents.create", { display_name: "Notes", markdown: "# Hi", admin: true })
    expect(JSON.parse(requests[0]!.body as string)).toEqual({ display_name: "Notes", markdown: "# Hi" })
  })

  test("a document id cannot be normalized into a different route", () => {
    for (const id of [".", ".."]) {
      expect(() => hostedOperationRequest("documents.get", { id })).toThrow(expect.objectContaining({ class: "invalid" }))
    }
  })
  test("a list reads the documents route with its scope", () => {
    expect(hostedOperationRequest("documents.list", { project_id: "p1", archived: "all" })).toEqual({
      method: "GET",
      path: "/documents?project_id=p1&archived=all",
    })
  })

  test("a content save sends the version it read as If-Match", () => {
    expect(hostedOperationRequest("documents.content.put", { id: "doc 1", ifMatch: "v3", display_name: "Notes", markdown: "# Hi" })).toEqual({
      method: "PUT",
      path: "/documents/doc%201/content",
      body: { display_name: "Notes", markdown: "# Hi" },
      headers: { "If-Match": "v3" },
    })
  })

  test("a restore names the snapshot in the path", () => {
    expect(hostedOperationRequest("documents.snapshots.restore", { id: "d", snapshotId: "s", ifMatch: "v1" })).toMatchObject({
      method: "POST",
      path: "/documents/d/snapshots/s/restore",
      headers: { "If-Match": "v1" },
    })
  })

  test("an unknown operation, a missing id or a non-object input is refused as invalid", () => {
    for (const [name, input] of [
      ["tasks.list", {}],
      ["documents.get", {}],
      ["documents.content.put", { id: "d" }],
      ["documents.list", ["p1"]],
    ] as const) {
      expect(() => hostedOperationRequest(name, input)).toThrow(expect.objectContaining({ class: "invalid" }))
    }
  })
})

describe("one routing owner for hosted operations", () => {
  const input = { id: "doc 1", ifMatch: "v3", display_name: "Notes", markdown: "# Hi" }

  test("on the web and the unsigned desktop an operation is the connected server's route", async () => {
    const requests: { path: string; init?: RequestInit }[] = []
    const transport = { json: async (path: string, init?: RequestInit) => (requests.push({ path, ...(init ? { init } : {}) }), { ok: true }) } as Pick<Transport, "json"> as Transport
    await createOperations(transport, undefined).run("documents.content.put", input)
    expect(requests).toEqual([{ path: "/documents/doc%201/content", init: { method: "PUT", headers: { "If-Match": "v3" }, body: JSON.stringify({ display_name: "Notes", markdown: "# Hi" }) } }])
  })

  test("on a signed desktop the same operation crosses main by name, and the server is not asked", async () => {
    const named: { operation: string; input?: Readonly<Record<string, unknown>> }[] = []
    const transport = { json: async () => Promise.reject(new Error("the connected server must not be asked")) } as Pick<Transport, "json"> as Transport
    const account = createHostedAccount(async (operation, given) => (named.push({ operation, ...(given ? { input: given } : {}) }), { id: "doc 1" }))
    expect(await createOperations(transport, account).run("documents.content.put", input)).toEqual({ id: "doc 1" })
    expect(named).toEqual([{ operation: "documents.content.put", input }])
  })

  test("a signed desktop refuses what the web refuses, before main is asked", async () => {
    const named: string[] = []
    const account = createHostedAccount(async (operation) => (named.push(operation), {}))
    const operations = createOperations({} as Transport, account)
    for (const [name, value] of [["documents.get", {}], ["account.cliExchange", {}], ["tasks.list", {}]] as const) {
      await expect(operations.run(name, value)).rejects.toMatchObject({ class: "invalid" })
    }
    expect(named).toEqual([])
  })
})

 test("invitation operations replace direct member addition", () => {
  expect(hostedOperationRequest("org.invitations.create", { orgId: "org 1", email: "a@example.com", role: "member" })).toEqual({ method: "POST", path: "/api/control/orgs/org%201/invitations", body: { email: "a@example.com", role: "member" } })
  expect(hostedOperationRequest("org.invitations.accept", { token: "t 1" })).toEqual({ method: "POST", path: "/api/control/invitations/t%201/accept", body: {} })
  expect(() => hostedOperationRequest("org.members.add", {})).toThrow()
})
