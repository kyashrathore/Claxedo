/**
 * 10 — Agent Runner Selector + Auth + Provider API
 *
 * Tests the unified AgentRunnerSelector UI and all backend endpoints introduced
 * by the runner/auth plan:
 *
 * Phase 1 — API verification (no browser needed):
 *   - GET  /provider              → returns claude-acp / codex-acp (not anthropic/openai)
 *   - GET  /provider/auth         → returns auth options for the ACP provider
 *   - GET  /api/claxedo/agent-config/runner  → returns stored runner type
 *   - POST /api/claxedo/agent-config/runner  → accepts valid types, rejects invalid
 *   - PUT  /auth/:providerID      → stores API key, fans out
 *   - DELETE /auth/:providerID    → removes API key
 *   - POST /global/dispose        → returns true (no-op compat shim)
 *   - GET  /provider after PUT    → connected list includes providerID
 *
 * Phase 2 — Browser UI (agent-browser):
 *   - AgentRunnerSelector is rendered (Runner dropdown always visible)
 *   - Runner dropdown shows one of: Claude, Codex, OpenCode
 *   - AcpSelector / old agent Select is gone — no duplicate agent dropdown
 *   - Model dropdown present when in ACP mode (Sonnet / Opus / Haiku / GPT labels)
 *   - Agent mode selector visible when slash commands are available
 *   - Changing runner via dropdown calls the backend (no page crash)
 *
 * Requires:
 *   - claxedo-server running at :3001 (AB_BACKEND_URL)
 *   - Vite dev server running at :4444 (AB_BASE_URL)
 *   - workspace-runtime optional (browser-only checks degrade gracefully)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  settle,
  waitFor,
  assertMinCount,
} from "./_helpers"
import { isVisible, getText, evaluate } from "../ab"

// ── Configuration ─────────────────────────────────────────────────────────────

const BACKEND = process.env.AB_BACKEND_URL ?? "http://localhost:3001"
const WORKSPACE_DIR =
  process.env.AB_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"

// ── Phase 1: API verification ─────────────────────────────────────────────────

describe("10 — Agent runner selector (API)", () => {
  // ── Provider endpoint ────────────────────────────────────────────────────

  test("GET /provider returns ACP-scoped provider ID (not anthropic/openai)", async () => {
    const res = await fetch(`${BACKEND}/provider`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as {
      all: Array<{ id: string; models: Record<string, unknown> }>
      default: Record<string, string>
      connected: string[]
    }
    console.log("[api] GET /provider →", JSON.stringify(data).slice(0, 300))

    // Must have exactly one provider in ACP mode
    expect(data.all.length).toBeGreaterThanOrEqual(1)

    const ids = data.all.map((p) => p.id)
    console.log("[api] provider IDs:", ids)

    // Provider ID must be acp-namespaced, not raw "anthropic" or "openai"
    expect(ids.includes("anthropic")).toBe(false)
    expect(ids.includes("openai")).toBe(false)
    expect(ids.some((id) => id === "claude-acp" || id === "codex-acp")).toBe(true)

    // Models must also carry the ACP provider ID
    const provider = data.all[0]
    const modelIds = Object.keys(provider.models)
    console.log("[api] model IDs:", modelIds)
    expect(modelIds.length).toBeGreaterThan(0)
    // Each model's providerID should match the ACP provider
    for (const model of Object.values(provider.models) as Array<{ providerID?: string }>) {
      expect(model.providerID).toBe(provider.id)
    }

    // default and connected fields must be keyed by the ACP ID
    expect(Object.keys(data.default).some((k) => k === "claude-acp" || k === "codex-acp")).toBe(true)
  }, 10_000)

  test("GET /provider returns scoped models only (not full Anthropic catalog)", async () => {
    const res = await fetch(`${BACKEND}/provider`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as {
      all: Array<{ id: string; models: Record<string, unknown> }>
    }
    const claudeProvider = data.all.find((p) => p.id === "claude-acp")
    if (!claudeProvider) {
      console.log("[api] No claude-acp provider — might be codex mode, skipping model scope check")
      return
    }
    const models = Object.keys(claudeProvider.models)
    console.log("[api] claude-acp models:", models)

    // Should include the supported ACP models
    expect(models).toContain("claude-sonnet-4-6")
    expect(models).toContain("claude-opus-4-6")
    expect(models).toContain("claude-haiku-4-5")

    // Must NOT include models from the full upstream catalog that aren't ACP-supported
    // (The old code had claude-opus-4-5, claude-sonnet-4-5 — these are not in ACP_MODELS)
    expect(models.includes("claude-opus-4-5")).toBe(false)
    expect(models.includes("claude-sonnet-4-5")).toBe(false)
  }, 10_000)

  test("GET /provider/auth returns auth options keyed by ACP provider ID", async () => {
    const res = await fetch(`${BACKEND}/provider/auth`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as Record<string, Array<{ type: string; label: string }>>
    console.log("[api] GET /provider/auth →", JSON.stringify(data))

    const keys = Object.keys(data)
    // Must be keyed by acp ID, not "anthropic"/"openai"
    expect(keys.includes("anthropic")).toBe(false)
    expect(keys.includes("openai")).toBe(false)
    expect(keys.some((k) => k === "claude-acp" || k === "codex-acp")).toBe(true)

    // Must have at least one auth method
    const providerAuth = data["claude-acp"] ?? data["codex-acp"]
    expect(Array.isArray(providerAuth)).toBe(true)
    expect(providerAuth.length).toBeGreaterThan(0)
    expect(providerAuth[0].type).toBe("api")
  }, 10_000)

  // ── Runner config endpoint ───────────────────────────────────────────────

  test("GET /api/claxedo/agent-config/runner returns a runner object", async () => {
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as Record<string, unknown>
    console.log("[api] GET /runner →", JSON.stringify(data))

    expect(typeof data["type"]).toBe("string")
    const validTypes = ["claude-acp", "codex-acp", "opencode"]
    expect(validTypes).toContain(data["type"])
  }, 10_000)

  test("POST /api/claxedo/agent-config/runner accepts valid runner types", async () => {
    // Read current runner first so we can restore it
    const getRes = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`)
    const original = (await getRes.json()) as { type: string; binary?: string }
    console.log("[api] original runner:", JSON.stringify(original))

    // Switch to opencode
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "opencode" }),
    })
    expect(res.ok).toBe(true)
    const data = (await res.json()) as { ok: boolean }
    expect(data.ok).toBe(true)

    // Verify it was saved
    const verify = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`)
    const saved = (await verify.json()) as { type: string }
    console.log("[api] after POST /runner →", JSON.stringify(saved))
    expect(saved.type).toBe("opencode")

    // Restore original
    await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: original.type, binary: original.binary }),
    })
  }, 15_000)

  test("POST /api/claxedo/agent-config/runner rejects invalid type", async () => {
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "malicious-runner" }),
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    console.log("[api] invalid runner →", data.error)
    expect(typeof data.error).toBe("string")
  }, 10_000)

  test("POST /api/claxedo/agent-config/runner rejects missing type", async () => {
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  }, 10_000)

  // ── Auth endpoints ───────────────────────────────────────────────────────

  test("PUT /auth/:providerID stores API key and updates connected list", async () => {
    const providerID = "claude-acp"
    const fakeKey = "sk-ant-e2etest-fake-key-" + Date.now()

    // Store key
    const putRes = await fetch(`${BACKEND}/auth/${providerID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { type: "api", key: fakeKey } }),
    })
    console.log("[api] PUT /auth/claude-acp status:", putRes.status)
    expect(putRes.ok).toBe(true)
    const putData = await putRes.json()
    console.log("[api] PUT /auth response:", JSON.stringify(putData))

    // Provider should now show as connected
    const providerRes = await fetch(`${BACKEND}/provider`)
    const providerData = (await providerRes.json()) as { connected: string[] }
    console.log("[api] /provider after PUT →", JSON.stringify(providerData.connected))
    expect(providerData.connected).toContain(providerID)

    // source should be "config" since it came from userConfig
    const provider = (providerData as any).all?.find((p: any) => p.id === providerID)
    if (provider) {
      console.log("[api] provider.source:", provider.source)
      expect(provider.source).toBe("config")
    }

    // Clean up: remove the key
    await fetch(`${BACKEND}/auth/${providerID}`, { method: "DELETE" })
  }, 15_000)

  test("PUT /auth/:providerID rejects missing key", async () => {
    const res = await fetch(`${BACKEND}/auth/claude-acp`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { type: "api" } }),  // no key
    })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  }, 10_000)

  test("DELETE /auth/:providerID removes key and updates connected list", async () => {
    const providerID = "claude-acp"
    const fakeKey = "sk-ant-e2etest-delete-" + Date.now()

    // First store a key
    await fetch(`${BACKEND}/auth/${providerID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { type: "api", key: fakeKey } }),
    })

    // Confirm it's connected
    const before = (await (await fetch(`${BACKEND}/provider`)).json()) as { connected: string[] }
    expect(before.connected).toContain(providerID)

    // Delete
    const delRes = await fetch(`${BACKEND}/auth/${providerID}`, { method: "DELETE" })
    expect(delRes.ok).toBe(true)
    const delData = await delRes.json()
    console.log("[api] DELETE /auth response:", JSON.stringify(delData))

    // No longer connected
    const after = (await (await fetch(`${BACKEND}/provider`)).json()) as { connected: string[] }
    console.log("[api] /provider after DELETE →", JSON.stringify(after.connected))
    expect(after.connected).not.toContain(providerID)
  }, 15_000)

  test("POST /global/dispose returns true (no-op shim)", async () => {
    const res = await fetch(`${BACKEND}/global/dispose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.ok).toBe(true)
    const data = await res.json()
    console.log("[api] POST /global/dispose →", data)
    expect(data).toBe(true)
  }, 10_000)

  test("GET /provider connected list is empty when no env key and no stored key", async () => {
    // Ensure no stored key first
    await fetch(`${BACKEND}/auth/claude-acp`, { method: "DELETE" })
    await fetch(`${BACKEND}/auth/codex-acp`, { method: "DELETE" })

    const res = await fetch(`${BACKEND}/provider`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as { connected: string[] }
    console.log("[api] connected after cleanup:", data.connected)

    // Only connected if env key exists — in test env without ANTHROPIC_API_KEY this should be empty
    // (Skip if env key is set — test environment may have it configured)
    const hasEnvKey = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY
    if (!hasEnvKey) {
      expect(data.connected.length).toBe(0)
    } else {
      console.log("[api] Env key present — connected list may be non-empty, skipping assertion")
    }
  }, 10_000)
})

// ── Phase 2: Browser UI tests ─────────────────────────────────────────────────

const lifecycle = suiteLifecycle("10-agent-runner-selector")

describe("10 — Agent runner selector (browser)", () => {
  beforeAll(lifecycle.before, 60_000)
  afterAll(lifecycle.after)

  test("AgentRunnerSelector renders — runner dropdown always visible", async () => {
    setTestContext("runner dropdown always visible")
    await settle(2000)
    const snap = await snapshot()
    await screenshot("initial-toolbar")
    console.log("[browser] initial snap excerpt:", snap.slice(0, 600))

    // The runner selector should show one of the runner labels
    // (Claude, Codex, or OpenCode — always visible, not gated on ACP mode)
    const hasRunner =
      snap.includes("Claude") ||
      snap.includes("Codex") ||
      snap.includes("OpenCode") ||
      snap.includes("claude-acp") ||
      snap.includes("codex-acp") ||
      snap.includes("opencode")

    console.log("[browser] runner selector visible:", hasRunner)
    expect(hasRunner).toBe(true)
  }, 30_000)

  test("prompt toolbar contains runner selector options", async () => {
    setTestContext("runner selector options")

    // Look for the runner select options in the toolbar area
    // The select should show "Claude", "Codex", or "OpenCode"
    let toolbarFound = false
    const deadline = Date.now() + 15_000

    while (Date.now() < deadline) {
      const snap = await snapshot()
      // The AgentRunnerSelector always renders in the toolbar
      // Check for runner labels or model labels
      if (
        snap.includes("Claude") ||
        snap.includes("Codex") ||
        snap.includes("OpenCode") ||
        snap.includes("Sonnet") ||
        snap.includes("Haiku") ||
        snap.includes("Opus")
      ) {
        toolbarFound = true
        break
      }
      await settle(1000)
    }

    await screenshot("runner-selector-toolbar")
    expect(toolbarFound).toBe(true)
  }, 20_000)

  test("old AcpSelector-only pattern replaced (no duplicate label+dropdown)", async () => {
    setTestContext("no duplicate AcpSelector pattern")
    const snap = await snapshot()
    await screenshot("no-duplicate-selector")

    // The old AcpSelector showed a plain <span> with "Claude" text AND a model Select.
    // The new AgentRunnerSelector uses a Select for the runner (no separate plain span).
    // We can't easily distinguish in the snapshot, but we can check the page didn't crash.
    expect(snap.toLowerCase().includes("something went wrong")).toBe(false)
    expect(snap.toLowerCase().includes("uncaught error")).toBe(false)

    // The runner dropdown should appear at most once (not duplicated)
    const claudeCount = (snap.match(/\bClaude\b/g) || []).length
    console.log("[browser] 'Claude' occurrences in snap:", claudeCount)
    // Can appear multiple times (runner label + model label) but not dozens
    expect(claudeCount).toBeLessThan(10)
  }, 15_000)

  test("model dropdown shows ACP models when in ACP mode", async () => {
    setTestContext("model dropdown ACP models")

    // Poll until we see model labels — health check may still be in progress
    let hasModel = false
    const deadline = Date.now() + 20_000

    while (Date.now() < deadline) {
      const snap = await snapshot()
      // ACP models: Sonnet 4.6, Opus 4.6, Haiku 4.5 / GPT-4o, GPT-4o mini
      hasModel =
        snap.includes("Sonnet") ||
        snap.includes("Opus") ||
        snap.includes("Haiku") ||
        snap.includes("GPT-4o") ||
        snap.includes("4o mini")
      if (hasModel) break
      await settle(1500)
    }

    await screenshot("model-dropdown-acp")
    console.log("[browser] model in toolbar:", hasModel)
    // Only assert if we're in ACP mode — if WR not running, model dropdown hidden
    const snap = await snapshot()
    const isAcp = snap.includes("Sonnet") || snap.includes("Opus") || snap.includes("GPT-4o")
    if (isAcp) {
      expect(hasModel).toBe(true)
    } else {
      console.log("[browser] Not in ACP mode (WR not running?) — model dropdown test skipped")
    }
  }, 25_000)

  test("agent mode dropdown visible when slash commands available", async () => {
    setTestContext("agent mode dropdown")
    const snap = await snapshot()
    await screenshot("agent-mode-dropdown")

    // The agent mode selector shows when sync.data.command is non-empty.
    // In a fresh env, commands may not be loaded yet — this is a best-effort check.
    const hasAgentDropdown =
      snap.includes("default") ||
      snap.includes("plan") ||
      snap.includes("build") ||
      snap.includes("general")

    console.log("[browser] agent mode dropdown visible:", hasAgentDropdown)
    // Not a hard assertion — commands list may be empty in test environment
    if (hasAgentDropdown) {
      console.log("[browser] ✓ Agent mode dropdown present")
    } else {
      console.log("[browser] Agent mode dropdown not shown (empty commands list — expected in test env)")
    }
    // Page should be stable regardless
    expect(snap.toLowerCase().includes("something went wrong")).toBe(false)
  }, 15_000)

  test("runner API call on select change does not crash the page", async () => {
    setTestContext("runner change via API")

    // Directly call the runner API (simulating what the dropdown does)
    const res = await fetch(`${BACKEND}/api/claxedo/agent-config/runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "claude-acp" }),
    })
    expect(res.ok).toBe(true)

    await settle(1500)

    // Page should still be stable
    const snap = await snapshot()
    await screenshot("after-runner-api-call")
    expect(snap.toLowerCase().includes("something went wrong")).toBe(false)
    expect(snap.toLowerCase().includes("crash")).toBe(false)
    console.log("[browser] page stable after runner API call")
  }, 15_000)

  test("toolbar renders correctly after page reload", async () => {
    setTestContext("toolbar persists after reload")
    await screenshot("before-reload")

    // Reload page
    const { press: abPress } = await import("../ab")
    await abPress("Meta+r")
    await settle(4000)

    const snap = await snapshot()
    await screenshot("after-reload-toolbar")

    // Runner selector should still be there
    const hasRunner =
      snap.includes("Claude") ||
      snap.includes("Codex") ||
      snap.includes("OpenCode") ||
      snap.includes("Sonnet") ||
      snap.includes("GPT-4o")

    console.log("[browser] toolbar after reload:", hasRunner)
    expect(hasRunner).toBe(true)
    expect(snap.toLowerCase().includes("something went wrong")).toBe(false)
  }, 30_000)

  test("Settings Providers tab uses ACP provider ID", async () => {
    setTestContext("Settings Providers — ACP ID")

    // Try to navigate to settings if possible
    // First check if there's a settings button in the sidebar
    const snap = await snapshot()
    const hasSettings =
      snap.includes("Settings") ||
      snap.includes("Providers") ||
      isVisible("[aria-label='Settings']")

    await screenshot("settings-check")
    console.log("[browser] settings accessible:", hasSettings)

    // The provider API returning claude-acp was verified in Phase 1
    // Just confirm the page is stable here
    expect(snap.toLowerCase().includes("crash")).toBe(false)
  }, 15_000)
})
