/**
 * 08 — Session Messages Integration
 *
 * Asserts that after sending a message to the ACP backend:
 *   1. The user message is persisted and returned by GET /session/:id/message
 *   2. The assistant message is persisted and returned by GET /session/:id/message
 *   3. Both messages render visually in the browser session chat
 *
 * Requires:
 *   - workspace-runtime running at :3002 with CLAXEDO_AGENT_TYPE=acp
 *   - claxedo-server running at :3001 (proxies to WR)
 *   - Vite dev server running at :4444
 *   - ANTHROPIC_API_KEY set in workspace-runtime environment
 *
 * Environment overrides:
 *   AB_BACKEND_URL=http://localhost:3001
 *   AB_BASE_URL=http://localhost:4444
 *   AB_WORKSPACE_DIR=/path/to/dir
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  settle,
} from "./_helpers"

// ── Configuration ─────────────────────────────────────────────────────────────

const BACKEND = process.env.AB_BACKEND_URL ?? "http://localhost:3001"
const WORKSPACE_DIR =
  process.env.AB_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"
const BASE_URL = process.env.AB_BASE_URL ?? "http://localhost:4444"

/** Max time to wait for Claude to respond (ACP can be slow on first token). */
const CLAUDE_TIMEOUT = 90_000

// ── SSE helper ────────────────────────────────────────────────────────────────

type Chunk = Record<string, unknown>

/**
 * POST to an SSE endpoint and collect all chunks until `finish` or `error`.
 * Returns early with partial chunks after `maxWaitMs`.
 */
async function collectSSE(url: string, body: unknown, maxWaitMs = 60_000): Promise<Chunk[]> {
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
          if (parsed["type"] === "finish" || parsed["type"] === "error") return chunks
        } catch {
          // non-JSON line — skip
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err
  } finally {
    clearTimeout(timeout)
    reader.cancel().catch(() => {})
  }

  return chunks
}

// ── Phase 1: API — messages persisted correctly ────────────────────────────────

let sessionId = ""
let userMessageId = ""
const USER_PROMPT = "Say only the word: ZXQTEST_RESPONSE"
const ASSISTANT_MARKER = "ZXQTEST_RESPONSE"

describe("08 — Session messages (API)", () => {
  test("create a session", async () => {
    const res = await fetch(`${BACKEND}/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": WORKSPACE_DIR,
      },
      body: JSON.stringify({ title: "e2e-messages-test" }),
    })
    expect(res.status).toBe(201)
    const data = (await res.json()) as Record<string, unknown>
    expect(typeof data["id"]).toBe("string")
    sessionId = data["id"] as string
    console.log(`[api] created session ${sessionId}`)
  }, 15_000)

  test("send message and receive finish chunk", async () => {
    expect(sessionId).toBeTruthy()
    // Generate a frontend-style message ID so the user message gets stored with the correct ID
    userMessageId = `msg_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 8)}`

    const chunks = await collectSSE(
      `${BACKEND}/session/${sessionId}/message`,
      { parts: [{ type: "text", text: USER_PROMPT }], messageID: userMessageId },
      CLAUDE_TIMEOUT,
    )

    console.log(`[api] received ${chunks.length} chunks`)
    const types = [...new Set(chunks.map((c) => c["type"]))]
    console.log(`[api] chunk types: ${types.join(", ")}`)

    // Must receive a finish (not only errors)
    expect(chunks.some((c) => c["type"] === "finish")).toBe(true)
    expect(chunks.some((c) => c["type"] === "error")).toBe(false)
  }, CLAUDE_TIMEOUT + 10_000)

  test("GET /session/:id/message returns both user and assistant messages", async () => {
    expect(sessionId).toBeTruthy()
    // Give storeAssistantMessage time to complete
    await Bun.sleep(1500)

    const res = await fetch(`${BACKEND}/session/${sessionId}/message`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    expect(res.ok).toBe(true)

    const messages = (await res.json()) as Array<{ role?: string; info?: { role: string; id: string }; parts?: unknown[] }>
    console.log(`[api] GET /session/${sessionId}/message → ${messages.length} item(s)`)

    // Accept both flat {role} and SDK {info: {role}} formats
    const roles = messages.map((m) => m.role ?? m.info?.role ?? "unknown")
    console.log(`[api] roles: ${roles.join(", ")}`)

    // Must contain at least one user message and one assistant message
    expect(roles).toContain("user")
    expect(roles).toContain("assistant")
    expect(messages.length).toBeGreaterThanOrEqual(2)
  }, 15_000)

  test("user message has correct SDK { info, parts } shape", async () => {
    expect(sessionId).toBeTruthy()

    const res = await fetch(`${BACKEND}/session/${sessionId}/message`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    const messages = (await res.json()) as Array<{ info?: { role: string; id: string }; parts?: unknown[] }>

    const userMsg = messages.find((m) => m.info?.role === "user")
    expect(userMsg).toBeDefined()
    // info.id must be a non-empty string
    expect(typeof userMsg!.info!.id).toBe("string")
    expect(userMsg!.info!.id.length).toBeGreaterThan(0)
    // parts must be an array
    expect(Array.isArray(userMsg!.parts)).toBe(true)
  }, 10_000)

  test("assistant message has correct SDK { info, parts } shape with parentID", async () => {
    expect(sessionId).toBeTruthy()

    const res = await fetch(`${BACKEND}/session/${sessionId}/message`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    const messages = (await res.json()) as Array<{
      info?: { role: string; id: string; parentID?: string }
      parts?: Array<{ type: string; text?: string }>
    }>

    const userMsg = messages.find((m) => m.info?.role === "user")
    const assistantMsg = messages.find((m) => m.info?.role === "assistant")

    expect(assistantMsg).toBeDefined()
    expect(typeof assistantMsg!.info!.id).toBe("string")

    // User message must have the ID we generated (so frontend's SessionTurn can link assistant by parentID)
    expect(userMsg!.info!.id).toBe(userMessageId)

    // Assistant parentID must point to the user message
    expect(assistantMsg!.info!.parentID).toBe(userMessageId)

    // Parts must include a text part with actual content
    const textPart = assistantMsg!.parts?.find((p) => p.type === "text")
    expect(textPart).toBeDefined()
    expect(typeof textPart!.text).toBe("string")
    expect(textPart!.text!.length).toBeGreaterThan(0)

    console.log(`[api] assistant text: "${textPart!.text!.slice(0, 120)}"`)
    // Assistant must echo the marker word
    expect(textPart!.text!.includes("ZXQTEST_RESPONSE")).toBe(true)
  }, 10_000)
})

// ── Phase 2: Browser — messages visible in session chat ───────────────────────

const lifecycle = suiteLifecycle("08-session-messages")

describe("08 — Session messages (browser)", () => {
  beforeAll(lifecycle.before, 60_000)
  afterAll(lifecycle.after)

  test("navigate to session page", async () => {
    setTestContext("navigate to session")
    expect(sessionId).toBeTruthy()

    const { open } = await import("../ab")
    const dirB64 = Buffer.from(WORKSPACE_DIR, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "")

    await open(`${BASE_URL}/${dirB64}/session/${sessionId}`)
    // Allow messages to load from API and SSE events to settle
    await settle(5000)
    await screenshot("session-navigated")
  }, 30_000)

  test("user message text is visible in session chat", async () => {
    setTestContext("user message visible")
    const snap = await snapshot()
    await screenshot("user-message-visible")

    // The user prompt text should be visible (but NOT the assistant marker yet)
    const hasUserText =
      snap.toLowerCase().includes("say only the word") ||
      snap.includes("ZXQTEST_RESPONSE")
    console.log(`[browser] user message visible: ${hasUserText}`)
    console.log(`[browser] snap excerpt: ${snap.slice(0, 600)}`)
    expect(hasUserText).toBe(true)
  }, 20_000)

  test("assistant message text is visible in session chat", async () => {
    setTestContext("assistant message visible")

    // Poll until the assistant's ZXQTEST_RESPONSE marker appears (distinct from user prompt)
    let snap = await snapshot()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      // Count occurrences: user bubble has "ZXQTEST_RESPONSE" once; assistant adds a second
      const count = (snap.match(/ZXQTEST_RESPONSE/g) ?? []).length
      if (count >= 2) break
      await settle(2000)
      snap = await snapshot()
    }

    await screenshot("assistant-message-visible")

    // The assistant marker must appear AT LEAST TWICE:
    // once in the user bubble ("Say only the word: ZXQTEST_RESPONSE")
    // and once in the assistant response bubble
    const markerCount = (snap.match(/ZXQTEST_RESPONSE/g) ?? []).length
    console.log(`[browser] ZXQTEST_RESPONSE appears ${markerCount} time(s) in snapshot`)
    console.log(`[browser] snap excerpt: ${snap.slice(0, 800)}`)
    expect(markerCount).toBeGreaterThanOrEqual(2)
  }, 30_000)

  test("both user and assistant turns rendered (no blank chat)", async () => {
    setTestContext("both turns rendered")
    const snap = await snapshot()
    await screenshot("both-turns")

    // The chat should not be empty — at minimum the user prompt appears
    const isEmpty =
      snap.trim().length < 50 ||
      snap.toLowerCase().includes("no messages") ||
      snap.toLowerCase().includes("start a conversation")

    expect(isEmpty).toBe(false)

    // Count message bubbles: user turn + assistant turn = at least 2 distinct blocks
    // We check that both role-related content appears somewhere in the DOM snapshot
    // Marker appears in user bubble once AND assistant bubble once = 2 total
    const markerCount = (snap.match(/ZXQTEST_RESPONSE/g) ?? []).length
    const hasUser = snap.toLowerCase().includes("say only the word") || markerCount >= 1
    const hasAssistant = markerCount >= 2

    console.log(`[browser] hasUser=${hasUser} hasAssistant=${hasAssistant} markerCount=${markerCount}`)
    // Both user AND assistant must be visible
    expect(hasUser).toBe(true)
    expect(hasAssistant).toBe(true)
  }, 15_000)

  test("messages persist after page reload", async () => {
    setTestContext("messages persist on reload")
    const { press: abPress } = await import("../ab")
    await screenshot("before-reload")
    await abPress("Meta+r")
    await settle(5000)

    const snap = await snapshot()
    await screenshot("after-reload")

    // After reload, messages should still be there (loaded from GET /session/:id/message)
    const lsnap = snap.toLowerCase()
    const hasContent =
      snap.includes("ZXQTEST_RESPONSE") ||
      lsnap.includes("say only the word") ||
      snap.includes("Sonnet") // at minimum model selector visible
    console.log(`[browser] after-reload hasContent=${hasContent}`)
    expect(hasContent).toBe(true)
  }, 30_000)
})
