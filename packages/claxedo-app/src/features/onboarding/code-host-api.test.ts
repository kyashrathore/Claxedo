import { describe, expect, test } from "bun:test"
import {
  codeHostFailureCopy,
  connectCodeHost,
  connectedCodeHosts,
  hasConnectedCodeHost,
  readCodeHostAttempt,
  readCodeHostStatus,
} from "./code-host-api"

const github = {
  id: "github",
  name: "GitHub",
  methods: ["key"],
  capabilities: ["code-host", "work-source"],
  prompts: [{ id: "token", label: "Fine-grained personal access token", secret: true }],
}

const notion = {
  id: "notion",
  name: "Notion",
  methods: ["key"],
  capabilities: ["work-source"],
  prompts: [],
}

const connection = (overrides: Record<string, unknown> = {}) => ({
  id: "conn-1",
  integrationId: "github",
  scope: "team",
  accountLabel: "kyashrathore",
  grantedCapabilities: ["code-host"],
  status: "connected",
  ...overrides,
})

const responding =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status })

describe("reading code-host status", () => {
  test("keeps only hosts that can serve a clone", async () => {
    const status = await readCodeHostStatus(
      responding({
        integrations: [github, notion],
        connections: [connection(), connection({ id: "conn-2", integrationId: "notion" })],
      }),
    )

    // Notion is a work source, not a code host — a cloud sandbox cannot clone
    // from it, so it is neither offered nor counted.
    expect(status.integrations.map((item) => item.id)).toEqual(["github"])
    expect(status.connections.map((item) => item.id)).toEqual(["conn-1"])
  })

  test("carries the account label so a connected row names whose account it is", async () => {
    const status = await readCodeHostStatus(responding({ integrations: [github], connections: [connection()] }))

    expect(status.connections[0]).toEqual({
      id: "conn-1",
      integrationId: "github",
      accountLabel: "kyashrathore",
      status: "connected",
    })
  })

  test("carries the prompts the connect form has to render", async () => {
    const status = await readCodeHostStatus(responding({ integrations: [github], connections: [] }))

    expect(status.integrations[0]!.methods).toEqual(["key"])
    expect(status.integrations[0]!.prompts).toEqual([
      { id: "token", label: "Fine-grained personal access token", secret: true },
    ])
  })

  test("a degraded connection still counts — it names an account and can be repaired", () => {
    const status = {
      integrations: [],
      connections: [{ id: "c", integrationId: "github", status: "degraded" as const }],
    }

    expect(hasConnectedCodeHost(status)).toBe(true)
    expect(connectedCodeHosts(status)).toHaveLength(1)
  })

  test("a broken connection does not count as a connected host", () => {
    const status = {
      integrations: [],
      connections: [{ id: "c", integrationId: "github", status: "broken" as const }],
    }

    expect(hasConnectedCodeHost(status)).toBe(false)
  })

  test("an unreachable or rejected route yields nothing rather than throwing", async () => {
    expect(await readCodeHostStatus(responding({ code: "connections_unavailable" }, 503))).toEqual({
      integrations: [],
      connections: [],
    })
    expect(await readCodeHostStatus(responding(null))).toEqual({ integrations: [], connections: [] })
  })

  test("a malformed payload yields nothing rather than a crash", async () => {
    const status = await readCodeHostStatus(
      responding({
        integrations: [null, { name: "no id" }, github],
        connections: [null, { id: "no-integration" }],
      }),
    )

    expect(status.integrations.map((item) => item.id)).toEqual(["github"])
    expect(status.connections).toEqual([])
  })

  test("an unrecognised status is treated as broken, not as connected", async () => {
    const status = await readCodeHostStatus(
      responding({
        integrations: [github],
        connections: [connection({ status: "something_new" })],
      }),
    )

    expect(hasConnectedCodeHost(status)).toBe(false)
  })
})

describe("connecting a code host", () => {
  test("a key connect sends the pasted secret and its fields", async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const outcome = await connectCodeHost({
      integrationId: "github",
      method: "key",
      secret: "github_pat_abc",
      request: async (path, init) => {
        calls.push({ path, body: JSON.parse(String(init?.body)) })
        return new Response(JSON.stringify({ ok: true }))
      },
    })

    expect(outcome).toEqual({ ok: true })
    expect(calls).toEqual([{ path: "/github/connect", body: { fields: {}, secret: "github_pat_abc" } }])
  })

  test("an oauth connect hands back the url to open and the attempt to poll", async () => {
    const outcome = await connectCodeHost({
      integrationId: "gitlab",
      method: "oauth",
      request: responding({ url: "https://gitlab.example/oauth", attemptId: "attempt-1" }),
    })

    expect(outcome).toEqual({ ok: true, oauth: { url: "https://gitlab.example/oauth", attemptId: "attempt-1" } })
  })

  test("a device grant carries the code the user has to type", async () => {
    // GitHub's device page asks for a code. Dropping it here would open a
    // page the user cannot complete.
    const outcome = await connectCodeHost({
      integrationId: "github",
      method: "oauth",
      request: responding({
        url: "https://github.com/login/device",
        attemptId: "attempt-1",
        userCode: "WDJB-MJHT",
        intervalMs: 5000,
      }),
    })

    expect(outcome).toEqual({
      ok: true,
      oauth: {
        url: "https://github.com/login/device",
        attemptId: "attempt-1",
        userCode: "WDJB-MJHT",
        intervalMs: 5000,
      },
    })
  })

  test("a rejected token comes back as a repair, never as a server code", async () => {
    const outcome = await connectCodeHost({
      integrationId: "github",
      method: "key",
      secret: "bad",
      request: responding({ code: "verify_failed", reason: "unauthorized" }, 400),
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain("copied whole")
    expect(outcome.ok === false && outcome.reason).not.toContain("verify_failed")
  })

  test("an unreachable server is a sentence, not an exception", async () => {
    const outcome = await connectCodeHost({
      integrationId: "github",
      method: "key",
      request: async () => {
        throw new Error("connection refused")
      },
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toContain("Couldn't reach the server")
  })
})

describe("waiting on a device grant", () => {
  test("a pending attempt keeps waiting", async () => {
    expect(await readCodeHostAttempt(responding({ status: "pending" }), "attempt-1")).toEqual({ state: "pending" })
  })

  test("a completed attempt is the connection being done", async () => {
    expect(await readCodeHostAttempt(responding({ status: "complete" }), "attempt-1")).toEqual({ state: "complete" })
  })

  test("an expired grant says to start again, not that it was refused", async () => {
    const outcome = await readCodeHostAttempt(responding({ status: "expired" }), "attempt-1")
    expect(outcome.state).toBe("failed")
    expect(outcome.state === "failed" && outcome.reason).toContain("expired")
  })

  test("a refused grant says so without echoing a server code", async () => {
    const outcome = await readCodeHostAttempt(responding({ status: "failed", message: "device_denied" }), "attempt-1")
    expect(outcome.state).toBe("failed")
    expect(outcome.state === "failed" && outcome.reason).not.toContain("device_denied")
  })

  test("a lost attempt is a failure, not an endless wait", async () => {
    const outcome = await readCodeHostAttempt(responding({ code: "attempt_not_found" }, 404), "attempt-1")
    expect(outcome.state).toBe("failed")
  })

  test("an unreachable server keeps the grant alive so a blip does not cancel it", async () => {
    const outcome = await readCodeHostAttempt(async () => {
      throw new Error("connection refused")
    }, "attempt-1")
    expect(outcome).toEqual({ state: "pending" })
  })

  test("the attempt id is escaped into the path", async () => {
    const paths: string[] = []
    await readCodeHostAttempt(async (path) => {
      paths.push(path)
      return new Response(JSON.stringify({ status: "pending" }))
    }, "a/../b")
    expect(paths).toEqual(["/attempts/a%2F..%2Fb"])
  })
})

describe("failure copy", () => {
  test.each([
    [{ code: "connection_exists" }, 409, "already connected"],
    [{ code: "verify_failed" }, 400, "copied whole"],
    [{}, 401, "copied whole"],
    [{}, 404, "doesn't offer that code host"],
    [{}, 500, "Try again"],
  ])("maps %o to a repair the user can act on", (body, status, expected) => {
    const copy = codeHostFailureCopy(body, status)
    expect(copy).toContain(expected)
    expect(copy).not.toMatch(/verify_failed|connection_exists|^\d{3}/)
  })

  test("reads a code nested under error, the shape some routes use", () => {
    expect(codeHostFailureCopy({ error: { code: "connection_exists" } }, 409)).toContain("already connected")
  })
})
