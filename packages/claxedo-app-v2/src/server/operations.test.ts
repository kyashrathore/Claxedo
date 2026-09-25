import { describe, expect, test } from "bun:test"
import { createHostedAccount } from "./account"
import { createOperations, hostedOperationRequest } from "./operations"
import type { Transport } from "./transport"

describe("hosted operations over the connected server's routes", () => {
  test("a list reads the documents route with its scope", () => {
    expect(hostedOperationRequest("documents.list", { project_id: "p1", archived: "all" })).toEqual({
      method: "GET",
      path: "/documents",
      query: { project_id: "p1", document_id: undefined, directory: undefined, archived: "all" },
    })
  })

  test("a content save sends the version it read as If-Match", () => {
    expect(hostedOperationRequest("documents.content.put", { id: "doc 1", ifMatch: "v3", display_name: "Notes", markdown: "# Hi" })).toEqual({
      method: "PUT",
      path: "/documents/doc%201/content",
      body: { display_name: "Notes", markdown: "# Hi" },
      ifMatch: "v3",
    })
  })

  test("a restore names the snapshot in the path", () => {
    expect(hostedOperationRequest("documents.snapshots.restore", { id: "d", snapshotId: "s", ifMatch: "v1" })).toMatchObject({
      method: "POST",
      path: "/documents/d/snapshots/s/restore",
      ifMatch: "v1",
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
