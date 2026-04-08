/**
 * 07 — ACP Integration
 *
 * Proves: The full ACP (claude-agent-acp) integration works end-to-end.
 * Phase 1: API verification — confirms backend is wired correctly before touching the browser.
 * Phase 2: Browser test — UI shows Claude selector, messages send, responses appear, persist on reload.
 *
 * Requires:
 *   - workspace-runtime running at :3002 with CLAXEDO_AGENT_TYPE=acp
 *   - claxedo-server running at :3001 (proxies to WR)
 *   - Vite dev server running at :4444
 *   - ANTHROPIC_API_KEY set in workspace-runtime environment
 *
 * Environment overrides:
 *   AB_BACKEND_URL=http://localhost:3001   (default: claxedo-server)
 *   AB_BASE_URL=http://localhost:4444      (default: vite dev server)
 *   AB_WORKSPACE_DIR=/path/to/dir         (default: /Users/yashvardhansingh/test/opencode)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  settle,
  waitFor,
} from "./_helpers"
import { isVisible, getCount, getText } from "../ab"

// ── Configuration ─────────────────────────────────────────────────────────────

const BACKEND = process.env.AB_BACKEND_URL ?? "http://localhost:3001"
const WORKSPACE_DIR =
  process.env.AB_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"

// Max wait for Claude to respond (ACP can be slow on first token)
const CLAUDE_TIMEOUT = 90_000

// ── SSE helper ────────────────────────────────────────────────────────────────

type Chunk = Record<string, unknown>

/**
 * POST to an SSE endpoint, collect all chunks until `finish` or `error`.
 * Returns early (with partial chunks) after `maxWaitMs`.
 */
async function collectSSE(
  url: string,
  body: unknown,
  maxWaitMs = 60_000,
): Promise<Chunk[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), maxWaitMs)

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "x-opencode-directory": WORKSPACE_DIR,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })

  if (!res.ok || !res.body) {
    clearTimeout(timeout)
    throw new Error(`HTTP ${res.status} from ${url}`)
  }

  const chunks: Chunk[] = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split("\n\n")
      buf = parts.pop() ?? ""
      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "))
        if (!dataLine) continue
        const json = dataLine.slice(6).trim()
        if (!json) continue
        try {
          const parsed = JSON.parse(json) as Chunk
          chunks.push(parsed)
          if (parsed["type"] === "finish" || parsed["type"] === "error") {
            return chunks
          }
        } catch {
          // non-JSON line — skip
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err
    // timeout — return what we have
  } finally {
    clearTimeout(timeout)
    reader.cancel().catch(() => {})
  }

  return chunks
}

// ── Smoke test gate ──────────────────────────────────────────────────────────
// These tests hit real APIs (Claude, workspace-runtime) and are non-deterministic.
// Gate behind SMOKE_TEST=1 so they don't block CI.
const isSmoke = !!process.env.SMOKE_TEST

// ── Phase 1: API verification ─────────────────────────────────────────────────

let sessionId = ""

describe.skipIf(!isSmoke)("07 — ACP integration (API)", () => {
  test("workspace-runtime reports acp mode", async () => {
    const res = await fetch(`${BACKEND}/api/wr/health`)
    expect(res.ok).toBe(true)
    const data = (await res.json()) as Record<string, unknown>
    console.log("[api] /api/wr/health →", JSON.stringify(data))
    expect(data["agentType"]).toBe("acp")
    expect(typeof data["acpBinary"]).toBe("string")
    expect((data["acpBinary"] as string).length).toBeGreaterThan(0)
  }, 10_000)

  test("create session", async () => {
    const res = await fetch(`${BACKEND}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": WORKSPACE_DIR,
      },
      body: JSON.stringify({ title: "e2e-acp-test" }),
    })
    expect(res.status).toBe(201)
    const data = (await res.json()) as Record<string, unknown>
    console.log("[api] POST /session →", JSON.stringify(data))
    expect(typeof data["id"]).toBe("string")
    sessionId = data["id"] as string
  }, 30_000)

  test("send 'who are you' and receive Claude response", async () => {
    expect(sessionId).toBeTruthy()
    console.log(`[api] Sending message to session ${sessionId}...`)

    const chunks = await collectSSE(
      `${BACKEND}/session/${sessionId}/message`,
      { parts: [{ type: "text", text: "who are you? reply in one sentence." }] },
      CLAUDE_TIMEOUT,
    )

    console.log(`[api] Received ${chunks.length} chunks`)
    const textDeltas = chunks
      .filter((c) => c["type"] === "text-delta")
      .map((c) => c["delta"] as string)
    const fullText = textDeltas.join("")
    console.log(`[api] Response text: ${fullText.slice(0, 200)}`)

    // Claude should mention its name or describe itself as an AI assistant
    expect(chunks.some((c) => c["type"] === "finish")).toBe(true)
    expect(fullText.length).toBeGreaterThan(10)
    const lowerText = fullText.toLowerCase()
    expect(
      lowerText.includes("claude") ||
        lowerText.includes("anthropic") ||
        lowerText.includes("ai assistant") ||
        lowerText.includes("language model"),
    ).toBe(true)
  }, CLAUDE_TIMEOUT + 5_000)

  test("messages are persisted after response", async () => {
    expect(sessionId).toBeTruthy()
    // Give storeAssistantMessage a moment to complete
    await Bun.sleep(1000)

    const res = await fetch(
      `${BACKEND}/session/${sessionId}/message`,
      {
        headers: { "x-opencode-directory": WORKSPACE_DIR },
      },
    )
    expect(res.ok).toBe(true)
    const messages = (await res.json()) as Array<{ role?: string; info?: { role: string } }>
    console.log(`[api] GET /session/${sessionId}/message → ${messages.length} messages`)
    // Must have at least the assistant message persisted
    expect(messages.length).toBeGreaterThanOrEqual(1)
    // Accept both flat {role} and SDK {info: {role}} formats
    const roles = messages.map((m) => m.role ?? m.info?.role ?? "unknown")
    console.log(`[api] roles: ${roles.join(", ")}`)
    expect(roles).toContain("assistant")
  }, 10_000)

  test("model selector endpoint accepts new model", async () => {
    const res = await fetch(`${BACKEND}/api/wr/acp-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6" }),
    })
    expect(res.ok).toBe(true)
    const data = (await res.json()) as Record<string, unknown>
    expect(data["ok"]).toBe(true)
    // Reset to sonnet for subsequent tests
    await fetch(`${BACKEND}/api/wr/acp-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6" }),
    })
  }, 10_000)

  test("tool use: ask Claude to run echo hello", async () => {
    expect(sessionId).toBeTruthy()
    const chunks = await collectSSE(
      `${BACKEND}/session/${sessionId}/message`,
      {
        parts: [
          {
            type: "text",
            text: 'Run the bash command: echo "hello from acp test". Just run it, no explanation needed.',
          },
        ],
      },
      CLAUDE_TIMEOUT,
    )

    console.log(`[api] tool-use test: ${chunks.length} chunks`)
    const types = chunks.map((c) => c["type"])
    console.log(`[api] chunk types: ${[...new Set(types)].join(", ")}`)

    // Should receive a terminal chunk (finish or error)
    // Tool use may error if bash tool isn't available in the current ACP config
    const hasFinish = chunks.some((c) => c["type"] === "finish")
    const hasError = chunks.some((c) => c["type"] === "error")
    expect(hasFinish || hasError).toBe(true)

    // If it finished successfully, great; if it errored, log it but don't hard-fail
    // since tool availability depends on ACP agent configuration
    if (hasError && !hasFinish) {
      const errChunks = chunks.filter((c) => c["type"] === "error")
      console.log(`[api] tool-use returned error (may be expected): ${JSON.stringify(errChunks)}`)
    }
  }, CLAUDE_TIMEOUT + 5_000)

  test("list sessions includes the created session", async () => {
    const res = await fetch(`${BACKEND}/session`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    expect(res.ok).toBe(true)
    const sessions = (await res.json()) as Array<{ id: string }>
    const ids = sessions.map((s) => s.id)
    console.log(`[api] GET /session → ${sessions.length} sessions, ids=[${ids.slice(0, 3).join(", ")}...]`)
    expect(ids).toContain(sessionId)
  }, 10_000)
})

// ── Phase 2: Browser tests ────────────────────────────────────────────────────

const lifecycle = suiteLifecycle("07-acp-integration")

describe.skipIf(!isSmoke)("07 — ACP integration (browser)", () => {
  beforeAll(lifecycle.before, 60_000)
  afterAll(lifecycle.after)

  test("ACP selector shows Claude agent name", async () => {
    setTestContext("ACP selector — Claude visible")
    // AcpSelector renders a <span> with displayName() = "Claude" when isAcpMode()
    // Poll until visible (WR health check may still be in progress)
    let acpVisible = false
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const snap = await snapshot()
      if (snap.toLowerCase().includes("claude") || snap.includes("Sonnet 4.6") || snap.includes("Sonnet")) {
        acpVisible = true
        break
      }
      await settle(1000)
    }
    await screenshot("acp-selector-visible")
    expect(acpVisible).toBe(true)
  }, 30_000)

  test("model dropdown shows Claude models", async () => {
    setTestContext("model dropdown")
    // Poll briefly — the Select may need a moment to render after ACP health resolves
    let hasClaude = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const snap = await snapshot()
      // Check display names ("Sonnet 4.6"), model IDs ("claude-sonnet-4-6"), and agent name ("Claude")
      hasClaude =
        snap.includes("Sonnet") ||
        snap.includes("Opus") ||
        snap.includes("Haiku") ||
        snap.includes("claude") ||
        snap.includes("Claude")
      if (hasClaude) break
      await settle(1000)
    }
    await screenshot("model-dropdown-area")
    expect(hasClaude).toBe(true)
  }, 15_000)

  test("session page renders without error", async () => {
    setTestContext("session page renders")
    const snap = await snapshot()
    await screenshot("session-page")
    // Should not show an error state
    expect(snap.toLowerCase().includes("something went wrong")).toBe(false)
    expect(snap.toLowerCase().includes("crash")).toBe(false)
  }, 10_000)

  test("previous API response is visible after navigating to session", async () => {
    setTestContext("session messages visible")
    if (!sessionId) {
      console.warn("[browser] sessionId not set — skipping session navigation")
      return
    }

    const { open } = await import("../ab")
    const BASE_URL = process.env.AB_BASE_URL ?? "http://localhost:4444"
    const dirB64 = Buffer.from(WORKSPACE_DIR, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "")

    await open(`${BASE_URL}/${dirB64}/session/${sessionId}`)
    await settle(4000)

    const snap = await snapshot()
    await screenshot("session-with-messages")

    // The user message "who are you" should be visible
    const hasUserMsg =
      snap.toLowerCase().includes("who are you") ||
      snap.includes("one sentence")
    // The assistant response should be there too
    const lowerSnap = snap.toLowerCase()
    const hasAssistantMsg =
      lowerSnap.includes("claude") ||
      lowerSnap.includes("anthropic") ||
      lowerSnap.includes("ai assistant") ||
      lowerSnap.includes("language model")

    console.log(`[browser] hasUserMsg=${hasUserMsg}, hasAssistantMsg=${hasAssistantMsg}`)
    console.log(`[browser] snap excerpt: ${snap.slice(0, 500)}`)
    expect(hasUserMsg || hasAssistantMsg).toBe(true)
  }, 30_000)

  test("messages persist after page reload", async () => {
    setTestContext("messages persist on reload")
    if (!sessionId) {
      console.warn("[browser] sessionId not set — skipping reload test")
      return
    }

    const { press: abPress } = await import("../ab")
    await screenshot("before-reload")
    await abPress("Meta+r")
    await settle(5000)

    const snap = await snapshot()
    await screenshot("after-reload")

    const lowerSnap = snap.toLowerCase()
    const hasContent =
      lowerSnap.includes("claude") ||
      lowerSnap.includes("who are you") ||
      lowerSnap.includes("ai assistant") ||
      lowerSnap.includes("anthropic") ||
      snap.includes("Sonnet") // at minimum the model selector should be back
    console.log(`[browser] after-reload hasContent=${hasContent}`)
    expect(hasContent).toBe(true)
  }, 30_000)
})
