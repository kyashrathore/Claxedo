import { describe, expect, test, vi } from "vitest"
import { d1HttpDatabase } from "./d1-http-database"
import { fetchJsonBody, fetchUrl } from "../../src/test-support/fetch-calls"

type Call = { url: string; authorization: string | null; body: Record<string, unknown> }

function api(reply: (call: Call) => Response) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: fetchUrl(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body: fetchJsonBody(init?.body),
    }
    calls.push(call)
    return reply(call)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const resultSet = (results: unknown[], changes?: number) =>
  Response.json({ success: true, errors: [], messages: [], result: [{ success: true, results, meta: { changes } }] })

describe("d1HttpDatabase", () => {
  const database = (fetchImpl: typeof fetch) =>
    d1HttpDatabase({ accountId: "acct/1", databaseId: "db-1", apiToken: "token-1", fetchImpl })

  test("sends each bound statement as one query and reads rows and change counts back", async () => {
    const { calls, fetchImpl } = api((call) => {
      if (String(call.body.sql).startsWith("select")) return resultSet([{ org_id: "org-a", provider_id: "openai" }])
      return resultSet([], 1)
    })
    const db = database(fetchImpl)

    const rows = await db.prepare("select org_id, provider_id from hosted_provider_credentials where org_id = ?").bind("org-a").all()
    expect(rows.results).toEqual([{ org_id: "org-a", provider_id: "openai" }])
    expect(await db.prepare("select 1").first()).toEqual({ org_id: "org-a", provider_id: "openai" })
    expect(await db.prepare("update hosted_provider_credentials set secret_envelope = ? where org_id = ?").bind("cenc1:x", "org-a").run()).toEqual({
      meta: { changes: 1 },
    })

    expect(calls[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/acct%2F1/d1/database/db-1/query")
    expect(calls[0].authorization).toBe("Bearer token-1")
    expect(calls[0].body).toEqual({ sql: "select org_id, provider_id from hosted_provider_credentials where org_id = ?", params: ["org-a"] })
    expect(calls[2].body).toEqual({
      sql: "update hosted_provider_credentials set secret_envelope = ? where org_id = ?",
      params: ["cenc1:x", "org-a"],
    })
  })

  test("an empty result set reads as no row", async () => {
    const { fetchImpl } = api(() => resultSet([]))
    expect(await database(fetchImpl).prepare("select 1").first()).toBeNull()
  })

  test("a failed query is an error carrying the API's reason, never an empty result", async () => {
    const { fetchImpl } = api(() =>
      Response.json({ success: false, errors: [{ code: 7500, message: "no such table" }], result: [] }, { status: 400 }),
    )
    await expect(database(fetchImpl).prepare("select 1").all()).rejects.toThrow(/HTTP 400.*no such table/)
  })
})
