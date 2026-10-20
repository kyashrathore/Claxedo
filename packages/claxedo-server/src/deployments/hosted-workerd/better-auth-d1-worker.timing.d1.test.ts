import { afterEach, expect, test } from "vitest"
import type { ExecutionContext } from "hono"
import { betterAuthD1WorkerEnv, workerDatabases, WORKER_ORIGIN as API, type WorkerDatabases } from "../../test-support/better-auth-d1-worker-env"
import { composeBetterAuthD1UserDeployedControlPlane } from "../../authority/adapters/worker/better-auth-d1-compose"
import { betterAuthD1CompositionInput, createBetterAuthD1Worker, type BetterAuthD1WorkerEnv } from "./better-auth-d1-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"

const active: WorkerDatabases[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((databases) => databases.dispose()))
})

async function databases() {
  const bound = await workerDatabases()
  active.push(bound)
  return bound
}

function timing(response: Response) {
  const entries = (response.headers.get("server-timing") ?? "").split(", ").filter(Boolean)
  return {
    marks: entries.filter((entry) => !entry.includes(";")),
    durations: entries.filter((entry) => entry.includes(";dur=")).map((entry) => entry.split(";dur=")[0]),
  }
}

/**
 * Every answer the Worker gives says where its time went, including the ones
 * that never reach the core app: the health probe, Better Auth's routes and a
 * refusal. The first request an isolate serves is marked cold, and the first
 * one that composes the control plane is marked so, which is how staging tells
 * an isolate start from a slow route.
 */
test("every Worker response carries Server-Timing, with the cold and compose marks on the requests that paid them", async () => {
  const env = betterAuthD1WorkerEnv(await databases())
  // The composition's readiness reads run past the request that built it,
  // under the request's waitUntil; the test waits for them before the
  // databases are disposed.
  const readiness: Promise<unknown>[] = []
  const context = { waitUntil: (work: Promise<unknown>) => void readiness.push(work) } as unknown as ExecutionContext
  const worker = createBetterAuthD1Worker({
    composition: settledCompositionCache(
      (bound: BetterAuthD1WorkerEnv) => composeBetterAuthD1UserDeployedControlPlane(betterAuthD1CompositionInput(bound)),
      (created) => created.authReady,
    ),
  })
  const health = await worker.fetch(new Request(`${API}/health`), env, context)
  expect(health.status).toBe(200)
  expect(timing(health)).toEqual({ marks: ["cold"], durations: ["auth", "limit", "d1", "do", "upstream", "total"] })
  expect(readiness).toHaveLength(0)

  const bootstrap = await worker.fetch(new Request(`${API}/api/claxedo/bootstrap`, { headers: { origin: API } }), env, context)
  expect(bootstrap.status).toBe(200)
  expect(timing(bootstrap).marks).toEqual(["compose"])
  expect(readiness).toHaveLength(1)

  const session = await worker.fetch(new Request(`${API}/api/auth/get-session`, { headers: { origin: API } }), env, context)
  expect(session.status).toBe(200)
  expect(timing(session).durations).toEqual(["auth", "limit", "d1", "do", "upstream", "total"])

  // Until a composition's readiness reads settle, every request builds its own
  // (settled-composition-cache.ts) and says so; a settled one is reused silently.
  await Promise.all(readiness)
  const descriptor = await worker.fetch(new Request(`${API}/api/claxedo/auth/descriptor`, { headers: { origin: API } }), env, context)
  expect(descriptor.status).toBe(200)
  expect(timing(descriptor).marks).toEqual([])
  expect(readiness).toHaveLength(2)

  const refused = await worker.fetch(new Request(`${API}/health`), { ...env, AUTH_DB: undefined } as unknown as BetterAuthD1WorkerEnv, context)
  expect(refused.status).toBe(503)
  expect(timing(refused).durations).toContain("total")
  await Promise.all(readiness)
})
