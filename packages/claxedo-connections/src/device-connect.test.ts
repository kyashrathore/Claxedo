import { describe, expect, test } from "bun:test"
import { createIntegrationRegistry } from "./registry.js"
import { createConnectionsService } from "./service.js"
import { createAttempts } from "./attempts.js"
import { createMemoryConnectionStore, createMemoryCredentialStore } from "./stores/memory.js"
import { connectionProviderId, type DevicePoll, type IntegrationDeclaration, type IntegrationImpl } from "./types.js"

const DEVICE_DECL: IntegrationDeclaration = {
  id: "github",
  name: "GitHub",
  methods: ["oauth", "key"],
  capabilities: ["code-host", "work-source"],
  keyTokenType: "bearer",
  prompts: [{ id: "token", label: "Token", secret: true }],
}

function harness(polls: DevicePoll[], options: { verifyLabel?: string } = {}) {
  const registry = createIntegrationRegistry()
  const started: number[] = []
  let pollIndex = 0
  const impl: IntegrationImpl = {
    verify: async () => ({ ok: true, ...(options.verifyLabel ? { accountLabel: options.verifyLabel } : {}) }),
    device: {
      async start() {
        started.push(1)
        return {
          deviceCode: "device-abc",
          userCode: "WDJB-MJHT",
          verificationUri: "https://github.com/login/device",
          intervalMs: 10,
          expiresAt: Date.now() + 900_000,
        }
      },
      async poll() {
        return polls[Math.min(pollIndex++, polls.length - 1)]!
      },
    },
  }
  registry.register(DEVICE_DECL, impl)
  const credentials = createMemoryCredentialStore()
  const connections = createMemoryConnectionStore()
  const attempts = createAttempts({ sweepIntervalMs: 0 })
  let nextId = 0
  const service = createConnectionsService({
    registry,
    credentials,
    connections,
    attempts,
    newId: () => `connection-${++nextId}`,
  })
  return { service, credentials, connections, started, polledTimes: () => pollIndex }
}

const authorized: DevicePoll = {
  status: "complete",
  tokens: { accessToken: "ghu_access", refreshToken: "ghr_refresh", expiresAt: Date.now() + 28_800_000 },
}

describe("device-flow connect", () => {
  test("connect hands back a url carrying the code and an attempt to poll", async () => {
    const { service, started } = harness([{ status: "pending" }])

    const result = await service.connectOAuth({ integrationId: "github" })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The app opens this URL verbatim, so the code the user must type has to
    // travel in it — an app-side surface never sees the grant otherwise.
    expect(result.url).toContain("https://github.com/login/device")
    expect(result.userCode).toBe("WDJB-MJHT")
    expect(result.attemptId).toBeTruthy()
    expect(started.length).toBe(1)
    await service.dispose()
  })

  test("the attempt stays pending while the user has not entered the code", async () => {
    const { service } = harness([{ status: "pending" }])
    const result = await service.connectOAuth({ integrationId: "github" })
    if (!result.ok) throw new Error("expected ok")

    expect((await service.pollAttempt(result.attemptId))?.status).toBe("pending")
    expect((await service.attemptStatus(result.attemptId))?.status).toBe("pending")
    await service.dispose()
  })

  test("an authorized grant stores the connection with its refresh token", async () => {
    const { service, credentials, connections } = harness([{ status: "pending" }, authorized], { verifyLabel: "octocat" })
    const result = await service.connectOAuth({ integrationId: "github" })
    if (!result.ok) throw new Error("expected ok")

    expect((await service.pollAttempt(result.attemptId))?.status).toBe("pending")
    expect((await service.pollAttempt(result.attemptId))?.status).toBe("complete")

    const rows = await connections.list()
    expect(rows.length).toBe(1)
    expect(rows[0]!.integrationId).toBe("github")
    expect(rows[0]!.accountLabel).toBe("octocat")
    expect(rows[0]!.grantedCapabilities).toEqual(["code-host", "work-source"])

    const providerId = connectionProviderId(rows[0]!.id)
    expect((await credentials.get(providerId))?.kind).toBe("oauth_token")
    const secret = JSON.parse((await credentials.readSecret(providerId))!)
    expect(secret).toEqual({ access: "ghu_access", refresh: "ghr_refresh" })
    await service.dispose()
  })

  test("the stored oauth token is served in the same slot a pasted key would be", async () => {
    const { service } = harness([authorized])
    const result = await service.connectOAuth({ integrationId: "github" })
    if (!result.ok) throw new Error("expected ok")
    await service.pollAttempt(result.attemptId)

    const rows = await service.list()
    const token = await service.getToken(rows[0]!.id, "code-host")
    expect(token).toEqual({ ok: true, response: { token: "ghu_access", tokenType: "bearer" } })
    await service.dispose()
  })

  test("a denied grant settles failed and stores nothing", async () => {
    const { service, connections } = harness([{ status: "denied" }])
    const result = await service.connectOAuth({ integrationId: "github" })
    if (!result.ok) throw new Error("expected ok")

    expect((await service.pollAttempt(result.attemptId))?.status).toBe("failed")
    expect((await service.attemptStatus(result.attemptId))?.status).toBe("failed")
    expect(await connections.list()).toEqual([])
    await service.dispose()
  })

  test("an expired device code settles expired so the surface restarts the grant", async () => {
    const { service, connections } = harness([{ status: "expired" }])
    const result = await service.connectOAuth({ integrationId: "github" })
    if (!result.ok) throw new Error("expected ok")

    expect((await service.pollAttempt(result.attemptId))?.status).toBe("expired")
    expect(await connections.list()).toEqual([])
    await service.dispose()
  })

  test("a settled attempt is never polled upstream again", async () => {
    const { service, polledTimes } = harness([authorized])
    const result = await service.connectOAuth({ integrationId: "github" })
    if (!result.ok) throw new Error("expected ok")

    await service.pollAttempt(result.attemptId)
    await service.pollAttempt(result.attemptId)
    await service.pollAttempt(result.attemptId)

    expect(polledTimes()).toBe(1)
    await service.dispose()
  })

  test("polling an unknown attempt is a miss, not a crash", async () => {
    const { service } = harness([authorized])
    expect(await service.pollAttempt("no-such-attempt")).toBeUndefined()
    await service.dispose()
  })

  test("a personal-scope device connect keeps the owner it was started with", async () => {
    const { service, connections } = harness([authorized])
    const result = await service.connectOAuth({ integrationId: "github", owner: "user-1" })
    if (!result.ok) throw new Error("expected ok")
    await service.pollAttempt(result.attemptId)

    const rows = await connections.list()
    expect(rows[0]!.owner).toBe("user-1")
    await service.dispose()
  })

  test("an existing connection blocks a device connect until replacement is confirmed", async () => {
    const { service } = harness([authorized])
    const first = await service.connectOAuth({ integrationId: "github" })
    if (!first.ok) throw new Error("expected ok")
    await service.pollAttempt(first.attemptId)

    expect(await service.connectOAuth({ integrationId: "github" })).toEqual({ ok: false, code: "connection_exists" })
    expect((await service.connectOAuth({ integrationId: "github", confirmReplace: true })).ok).toBe(true)
    await service.dispose()
  })

  test("an integration with neither redirect nor device oauth is unknown to connectOAuth", async () => {
    const registry = createIntegrationRegistry()
    registry.register({ ...DEVICE_DECL, methods: ["oauth"] }, { verify: async () => ({ ok: true }) })
    const service = createConnectionsService({
      registry,
      credentials: createMemoryCredentialStore(),
      connections: createMemoryConnectionStore(),
      attempts: createAttempts({ sweepIntervalMs: 0 }),
      newId: () => "connection-1",
    })

    expect(await service.connectOAuth({ integrationId: "github" })).toEqual({ ok: false, code: "unknown_integration" })
    await service.dispose()
  })
})
