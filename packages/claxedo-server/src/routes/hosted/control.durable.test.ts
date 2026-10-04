import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest"
import { createIdempotencyCoordinator, d1ProjectionCommandIdempotency, IDEMPOTENCY_INFLIGHT_TTL_MS } from "../../authority/http/idempotency"
import { miniflareControlPlaneDatabase, type ControlPlaneDatabase } from "../../test-support/control-plane-migrations"

const pulls = vi.hoisted(() => ({ session: vi.fn(), messages: vi.fn() }))
vi.mock("../../authority/hosted-session-pull", () => ({
  pullHostedControlSession: pulls.session,
  pullHostedControlSessionMessages: pulls.messages,
}))

const authConfig = { enabled: true, issuer: "https://auth.test", jwksUrl: "https://auth.test/jwks" } as const
const verifier = async (token: string) => ({ mode: "signed" as const, user: { subject: token, issuer: authConfig.issuer, tokenIdentifier: token } })
const request = (operation: string, key: string, reason = "repair") => new Request(`https://control.test/workspaces/ws/sessions/ses/${operation}`, {
  method: "POST", headers: { authorization: "Bearer alice", "content-type": "application/json" },
  body: JSON.stringify({ idempotencyKey: key, reason }),
})

let d1: ControlPlaneDatabase
beforeAll(async () => {
  d1 = await miniflareControlPlaneDatabase()
})
afterAll(async () => {
  await d1.dispose()
})
beforeEach(async () => {
  await d1.database.prepare("delete from projection_command_idempotency").run()
  pulls.session.mockReset()
  pulls.messages.mockReset()
})

/** A fresh module graph is a fresh isolate: its per-process session locks start empty. */
async function instance(database = d1.database) {
  vi.resetModules()
  const { HostedControlRoutes } = await import("./control")
  const idempotency = createIdempotencyCoordinator(d1ProjectionCommandIdempotency(database))
  return HostedControlRoutes({} as never, { authConfig, verifier, idempotency })
}

test.each(["register", "checkpoint", "repair"])("independent instances sharing D1 apply %s once", async (operation) => {
  pulls.session.mockResolvedValue({ ok: true, sessionId: "ses" })
  pulls.messages.mockResolvedValue({ ok: true, maxEventOrdinal: 73 })
  const original = await (await instance()).fetch(request(operation, operation))
  const replay = await (await instance()).fetch(request(operation, operation))
  expect([original.status, replay.status]).toEqual([200, 200])
  expect(await replay.json()).toEqual(await original.json())
  expect(pulls.session).toHaveBeenCalledTimes(operation === "checkpoint" ? 0 : 1)
  expect(pulls.messages).toHaveBeenCalledTimes(operation === "register" ? 0 : 1)
})

test("a concurrent or changed command is refused while the first runs, and the first's result replays", async () => {
  const result = Promise.withResolvers<{ ok: true }>()
  pulls.session.mockImplementation(() => result.promise)
  const first = await instance()
  const second = await instance()
  const pending = first.fetch(request("register", "pending"))
  await vi.waitFor(() => expect(pulls.session).toHaveBeenCalledTimes(1))

  const retry = await second.fetch(request("register", "pending"))
  expect(retry.status).toBe(409)
  expect(await retry.json()).toMatchObject({ error: { code: "control_plane_idempotency_in_flight" } })
  const changed = await second.fetch(request("register", "pending", "different"))
  expect(changed.status).toBe(409)
  expect(await changed.json()).toMatchObject({ error: { code: "control_plane_idempotency_payload_mismatch" } })

  result.resolve({ ok: true })
  expect((await pending).status).toBe(200)
  const replay = await (await instance()).fetch(request("register", "pending"))
  expect(replay.status).toBe(200)
  expect(await replay.json()).toEqual({ ok: true })
  expect(pulls.session).toHaveBeenCalledTimes(1)
})

/** D1 dates a lease by its own clock, so time passes for a claim by moving its deadline back. */
async function elapse(ms: number) {
  await d1.database.prepare("update projection_command_idempotency set expires_at = expires_at - ?").bind(ms).run()
}

test("a command whose instance died is taken over after the lease, never inside it", async () => {
  pulls.session.mockImplementationOnce(() => new Promise(() => {}))
  void (await instance()).fetch(request("register", "crashed"))
  await vi.waitFor(() => expect(pulls.session).toHaveBeenCalledTimes(1))

  await elapse(IDEMPOTENCY_INFLIGHT_TTL_MS - 1_000)
  const inside = await (await instance()).fetch(request("register", "crashed"))
  expect(inside.status).toBe(409)
  expect(pulls.session).toHaveBeenCalledTimes(1)

  await elapse(1_000)
  pulls.session.mockResolvedValue({ ok: true, sessionId: "ses" })
  const takeover = await (await instance()).fetch(request("register", "crashed"))
  expect(takeover.status).toBe(200)
  const replay = await (await instance()).fetch(request("register", "crashed"))
  expect(await replay.json()).toEqual({ ok: true, sessionId: "ses" })
  expect(pulls.session).toHaveBeenCalledTimes(2)
})

test("a failed command releases its claim for the retry, and a storage failure refuses the command", async () => {
  pulls.session.mockRejectedValueOnce(new Error("pull failed")).mockResolvedValue({ ok: true })
  expect((await (await instance()).fetch(request("register", "retry"))).status).toBe(500)
  expect((await (await instance()).fetch(request("register", "retry"))).status).toBe(200)
  expect(pulls.session).toHaveBeenCalledTimes(2)

  const unavailable = await miniflareControlPlaneDatabase()
  await unavailable.dispose()
  expect((await (await instance(unavailable.database)).fetch(request("register", "unavailable"))).status).toBe(500)
  expect(pulls.session).toHaveBeenCalledTimes(2)
})
