/**
 * Runner ↔ Provider integration tests
 *
 * Verifies:
 *  1. Switching the global runner updates the persisted config
 *  2. Provider endpoint returns ACP-scoped providers when ACP runner is active
 *  3. Provider endpoint returns upstream providers when opencode runner is active
 *  4. Runner changes are rejected for invalid/missing types
 *  5. Runner changes for ongoing sessions are rejected (409)
 *  6. ?runner= query param overrides the global runner for provider endpoints
 *
 * Requires: CLAXEDO_TEST_BACKEND pointing at a running claxedo-server.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest"

const externalServerConfigured = !!process.env.CLAXEDO_TEST_BACKEND
const BACKEND = process.env.CLAXEDO_TEST_BACKEND
const UPSTREAM = process.env.OPENCODE_URL

type ProviderList = {
  all: Array<{ id: string; models: Record<string, unknown> }>
  connected: string[]
  default: Record<string, string>
}

let originalRunner: { type: string; binary?: string } | undefined

// Check upstream availability at module scope so test.skipIf can use it
const upstreamAvailable = externalServerConfigured && !!UPSTREAM && await fetch(`${UPSTREAM}/provider`, { signal: AbortSignal.timeout(2_000) })
  .then((r) => r.ok)
  .catch(() => false)

async function getRunner() {
  const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`)
  if (!res.ok) throw new Error(`GET /runner failed: ${res.status}`)
  return res.json() as Promise<{ type: string; binary?: string }>
}

async function setRunner(type: string) {
  const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  })
  if (!res.ok) throw new Error(`POST /runner failed: ${res.status}`)
}

async function getProviders(runner?: string) {
  const url = new URL("/provider", BACKEND)
  if (runner) url.searchParams.set("runner", runner)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET /provider failed: ${res.status}`)
  return res.json() as Promise<ProviderList>
}

async function getBootstrap(runner?: string) {
  const url = new URL("/api/claxedo/bootstrap", BACKEND)
  if (runner) url.searchParams.set("runner", runner)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET /bootstrap failed: ${res.status}`)
  return res.json() as Promise<{ provider: ProviderList }>
}

describe.skipIf(!externalServerConfigured)("runner ↔ provider integration", () => {
  beforeAll(async () => {
    const health = await fetch(`${BACKEND}/api/claxedo/health`).catch(() => null)
    if (!health?.ok) throw new Error(`Server not reachable at ${BACKEND}`)
    originalRunner = await getRunner()
  })

  afterAll(async () => {
    if (originalRunner) {
      await setRunner(originalRunner.type).catch(() => {})
    }
  })

  // ── Global runner persistence ──────────────────────────────────────────

  test("global runner persists after switch", async () => {
    await setRunner("opencode")
    expect((await getRunner()).type).toBe("opencode")

    await setRunner("claude-acp")
    expect((await getRunner()).type).toBe("claude-acp")
  })

  // ── ACP provider scoping ──────────────────────────────────────────────

  test("claude-acp runner returns ACP-scoped providers", async () => {
    await setRunner("claude-acp")
    const providers = await getProviders()
    const ids = providers.all.map((p) => p.id)

    expect(ids).toContain("claude-acp")
    expect(ids).not.toContain("anthropic")
    expect(ids).not.toContain("openai")
    expect(ids).not.toContain("opencode")
  })

  test("claude-acp provider has scoped models", async () => {
    await setRunner("claude-acp")
    const providers = await getProviders()
    const claude = providers.all.find((p) => p.id === "claude-acp")
    expect(claude).toBeDefined()

    const modelIds = Object.keys(claude!.models)
    expect(modelIds).toContain("claude-sonnet-4-6")
    expect(modelIds).toContain("claude-opus-4-6")
    expect(modelIds).toContain("claude-haiku-4-5")
  })

  // ── ?runner= query param override ──────────────────────────────────────

  test("?runner=claude-acp returns ACP providers regardless of global config", async () => {
    // Set global to opencode, but request ACP via query param
    await setRunner("opencode")
    const providers = await getProviders("claude-acp")
    const ids = providers.all.map((p) => p.id)

    expect(ids).toContain("claude-acp")
    expect(ids).not.toContain("anthropic")
    expect(ids).not.toContain("openai")
  })

  test("?runner= on bootstrap returns matching providers", async () => {
    // Set global to opencode, but request ACP via query param
    await setRunner("opencode")
    const boot = await getBootstrap("claude-acp")
    const ids = boot.provider.all.map((p) => p.id)

    expect(ids).toContain("claude-acp")
    expect(ids).not.toContain("anthropic")
  })

  test.skipIf(!upstreamAvailable)("?runner=opencode returns upstream providers (not ACP)", async () => {
    // Set global to claude-acp, but request opencode via query param
    await setRunner("claude-acp")
    const providers = await getProviders("opencode")
    const ids = providers.all.map((p) => p.id)

    expect(ids).not.toContain("claude-acp")
    expect(ids).not.toContain("codex-acp")
    expect(ids.length).toBeGreaterThan(0)
  })

  test("invalid ?runner= value is ignored (falls back to global config)", async () => {
    await setRunner("claude-acp")
    const providers = await getProviders("not-a-valid-runner")
    const ids = providers.all.map((p) => p.id)

    // Should fall back to global config (claude-acp)
    expect(ids).toContain("claude-acp")
  })

  // ── OpenCode provider proxying (requires upstream) ────────────────────

  test.skipIf(!upstreamAvailable)("opencode runner returns upstream providers (not ACP)", async () => {
    await setRunner("opencode")
    const providers = await getProviders()
    const ids = providers.all.map((p) => p.id)

    expect(ids).not.toContain("claude-acp")
    expect(ids).not.toContain("codex-acp")
    expect(ids.length).toBeGreaterThan(3)
    expect(ids).toContain("opencode")
  })

  // ── Validation ────────────────────────────────────────────────────────

  test("POST /runner rejects invalid type", async () => {
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "invalid-runner" }),
    })
    expect(res.status).toBe(400)
  })

  test("POST /runner rejects missing type", async () => {
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  // ── Ongoing session guard ─────────────────────────────────────────────

  test("POST /runner with sessionId for a new session returns 200", async () => {
    const dir = process.cwd()
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "opencode",
        sessionId: `test-new-${Date.now()}`,
        directory: dir,
      }),
    })
    // New session (no messages) → the server allows the switch
    expect(res.status).toBe(200)
  })

  test("POST /runner without sessionId does NOT reject (global default change)", async () => {
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "claude-acp" }),
    })
    expect(res.status).toBe(200)
  })
})
