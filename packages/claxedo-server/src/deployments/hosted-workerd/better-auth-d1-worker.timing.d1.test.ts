import { readdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"
import { Miniflare } from "miniflare"
import type { D1Database } from "@cloudflare/workers-types"
import { applyControlPlaneBaseline } from "../../test-support/control-plane-migrations"
import { composeBetterAuthD1UserDeployedControlPlane } from "../../authority/adapters/worker/better-auth-d1-compose"
import { betterAuthD1CompositionInput, createBetterAuthD1Worker, type BetterAuthD1WorkerEnv } from "./better-auth-d1-worker.cf"
import { settledCompositionCache } from "./settled-composition-cache"

const AUTH_MIGRATIONS = fileURLToPath(new URL("../../../migrations/auth/", import.meta.url))
const API = "https://api.example.test"
const APP = "https://app.example.test"

const active: Miniflare[] = []

afterEach(async () => {
  await Promise.all(active.splice(0).map((instance) => instance.dispose()))
})

async function databases() {
  const instance = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    compatibilityDate: "2025-05-01",
    d1Databases: ["AUTH_DB", "CONTROL_PLANE_DB"],
  })
  active.push(instance)
  const authDatabase = await instance.getD1Database("AUTH_DB")
  for (const name of readdirSync(AUTH_MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
    const migration = (await readFile(`${AUTH_MIGRATIONS}${name}`, "utf8")).replace(/^\s*--.*$/gm, "")
    for (const statement of migration.split(/;\s*\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
      await authDatabase.prepare(statement).run()
    }
  }
  const controlPlaneDatabase = await instance.getD1Database("CONTROL_PLANE_DB")
  await applyControlPlaneBaseline(controlPlaneDatabase)
  return { authDatabase, controlPlaneDatabase }
}

function workerEnv(bound: { authDatabase: D1Database; controlPlaneDatabase: D1Database }): BetterAuthD1WorkerEnv {
  return {
    AUTH_DB: bound.authDatabase,
    CONTROL_PLANE_DB: bound.controlPlaneDatabase,
    CLAXEDO_REQUEST_LIMITER: { limit: async () => ({ success: true }) },
    LIVE_SYNC_ROOM: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) },
    CLAXEDO_DOCUMENTS: { get: async () => null, put: async () => null, delete: async () => undefined, list: async () => ({ objects: [] }) },
    CF_VERSION_METADATA: { id: "11111111-1111-1111-1111-111111111111", tag: "claxedo-0123abcd" },
    CLAXEDO_ADAPTER_PROFILE: "better-auth-d1",
    CLAXEDO_PRODUCT_POSTURE: "user-deployed",
    CLAXEDO_SANDBOX_POSTURE: "control-plane-only",
    CLAXEDO_DEPLOYMENT_ID: "deployment-1",
    CLAXEDO_DEPLOYMENT_MODE: "hosted",
    CLAXEDO_AUTH_METHODS: "github",
    CLAXEDO_AUTH_CONFIGURATION_ID: "sha256:auth-configuration",
    BETTER_AUTH_URL: API,
    CLAXEDO_APP_ORIGIN: APP,
    BETTER_AUTH_SECRET: "better-auth-secret-that-is-at-least-thirty-two-bytes",
    CLAXEDO_AUTH_INTROSPECTION_SECRET: "introspection-secret-that-is-also-at-least-thirty-two-bytes",
    GITHUB_CLIENT_ID: "github-client",
    GITHUB_CLIENT_SECRET: "github-secret",
    CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.example.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: [
      "-----BEGIN PRIVATE KEY-----",
      "MC4CAQAwBQYDK2VwBCIEIO9Cnka2wu8+h1a1Rd+bDejAsq2oUxO6BnDKjrHrpw54",
      "-----END PRIVATE KEY-----",
    ].join("\n"),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: [
      "-----BEGIN PUBLIC KEY-----",
      "MCowBQYDK2VwAyEAvy35aYUPAjG/Zac6ER0AiB0BZteRmYnpMZ5b1U0SJGs=",
      "-----END PUBLIC KEY-----",
    ].join("\n"),
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_ID: "org_deployment",
    CLAXEDO_USER_DEPLOYED_ORGANIZATION_NAME: "My deployment",
  } as unknown as BetterAuthD1WorkerEnv
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
  const env = workerEnv(await databases())
  // The composition's readiness reads run past the request that built it, so
  // the test waits for them before the databases are disposed.
  const readiness: Promise<void>[] = []
  const worker = createBetterAuthD1Worker({
    composition: settledCompositionCache(
      (bound: BetterAuthD1WorkerEnv) => composeBetterAuthD1UserDeployedControlPlane(betterAuthD1CompositionInput(bound)),
      (created) => (readiness.push(created.authReady), created.authReady),
    ),
  })
  const health = await worker.fetch(new Request(`${API}/health`), env)
  expect(health.status).toBe(200)
  expect(timing(health)).toEqual({ marks: ["cold"], durations: ["auth", "limit", "d1", "do", "total"] })

  const bootstrap = await worker.fetch(new Request(`${API}/api/claxedo/bootstrap`, { headers: { origin: APP } }), env)
  expect(bootstrap.status).toBe(200)
  expect(timing(bootstrap).marks).toEqual(["compose"])
  expect(bootstrap.headers.get("timing-allow-origin")).toBe(APP)

  const session = await worker.fetch(new Request(`${API}/api/auth/get-session`, { headers: { origin: APP } }), env)
  expect(session.status).toBe(200)
  expect(timing(session).durations).toEqual(["auth", "limit", "d1", "do", "total"])
  expect(session.headers.get("timing-allow-origin")).toBe(APP)

  // Until a composition's readiness reads settle, every request builds its own
  // (settled-composition-cache.ts) and says so; a settled one is reused silently.
  await Promise.all(readiness)
  const descriptor = await worker.fetch(new Request(`${API}/api/claxedo/auth/descriptor`, { headers: { origin: APP } }), env)
  expect(descriptor.status).toBe(200)
  expect(timing(descriptor).marks).toEqual([])

  const refused = await worker.fetch(new Request(`${API}/health`), { ...env, AUTH_DB: undefined } as unknown as BetterAuthD1WorkerEnv)
  expect(refused.status).toBe(503)
  expect(timing(refused).durations).toContain("total")
  await Promise.all(readiness)
})
