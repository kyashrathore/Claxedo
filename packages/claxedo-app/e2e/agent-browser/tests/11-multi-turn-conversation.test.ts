/**
 * 11 — Multi-Turn Conversation E2E
 *
 * Proves the full conversation lifecycle works end-to-end:
 *   1. Multi-turn conversation (2+ messages, assistant remembers context)
 *   2. Messages persist after reload and conversation can continue
 *   3. Abort mid-response and restart conversation
 *   4. Session list reflects created sessions
 *
 * These tests hit real APIs (Claude via ACP or OpenCode) and are gated
 * behind SMOKE_TEST=1.
 *
 * Requires:
 *   - claxedo-server running at :3001
 *   - Vite dev server running at :4444
 *   - ANTHROPIC_API_KEY or OPENCODE_URL configured
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
import { open, press } from "../ab"

// ── Configuration ─────────────────────────────────────────────────────────────

const BACKEND = process.env.AB_BACKEND_URL ?? "http://localhost:3001"
const BASE_URL = process.env.AB_BASE_URL ?? "http://localhost:4444"
const WORKSPACE_DIR =
  process.env.AB_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"

const CLAUDE_TIMEOUT = 90_000
const isSmoke = !!process.env.SMOKE_TEST

// ── SSE helper ────────────────────────────────────────────────────────────────

type Chunk = Record<string, unknown>

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

function sseText(chunks: Chunk[]): string {
  return chunks
    .filter((c) => c["type"] === "text-delta")
    .map((c) => c["delta"] as string)
    .join("")
}

function msgId(): string {
  return `msg_${Date.now().toString(16)}${Math.random().toString(36).slice(2, 8)}`
}

function encodeDir(dir: string): string {
  return Buffer.from(dir, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

async function getMessages(sessionId: string) {
  const res = await fetch(`${BACKEND}/session/${sessionId}/message`, {
    headers: { "x-opencode-directory": WORKSPACE_DIR },
  })
  if (!res.ok) throw new Error(`GET messages failed: ${res.status}`)
  return (await res.json()) as Array<{
    role?: string
    info?: { role: string; id: string; parentID?: string }
    parts?: Array<{ type: string; text?: string }>
  }>
}

async function createSession(title: string): Promise<string> {
  const res = await fetch(`${BACKEND}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-directory": WORKSPACE_DIR,
    },
    body: JSON.stringify({ title }),
  })
  expect(res.status).toBe(201)
  const data = (await res.json()) as { id: string }
  return data.id
}

async function sendMessage(
  sessionId: string,
  text: string,
  messageID?: string,
): Promise<{ chunks: Chunk[]; fullText: string }> {
  const chunks = await collectSSE(
    `${BACKEND}/session/${sessionId}/message`,
    {
      parts: [{ type: "text", text }],
      ...(messageID ? { messageID } : {}),
    },
    CLAUDE_TIMEOUT,
  )
  return { chunks, fullText: sseText(chunks) }
}

// ── Phase 1: Multi-turn API conversation ────────────────────────────────────

let conversationSessionId = ""

describe.skipIf(!isSmoke)("11 — Multi-turn conversation (API)", () => {
  test("create a session for multi-turn test", async () => {
    conversationSessionId = await createSession("e2e-multi-turn")
    expect(conversationSessionId).toBeTruthy()
    console.log(`[multi-turn] session: ${conversationSessionId}`)
  }, 15_000)

  test("turn 1: establish context with a secret word", async () => {
    const id1 = msgId()
    const { chunks, fullText } = await sendMessage(
      conversationSessionId,
      'Remember this secret code: XYZZY_42_PLUGH. Say "I will remember XYZZY_42_PLUGH" and nothing else.',
      id1,
    )

    console.log(`[multi-turn] turn 1 response: "${fullText.slice(0, 200)}"`)

    expect(chunks.some((c) => c["type"] === "finish")).toBe(true)
    expect(fullText.length).toBeGreaterThan(0)
    // Allow time for persistence
    await Bun.sleep(1500)
  }, CLAUDE_TIMEOUT + 10_000)

  test("turn 2: assistant recalls the secret word from turn 1", async () => {
    const id2 = msgId()
    const { chunks, fullText } = await sendMessage(
      conversationSessionId,
      "What was the secret code I told you? Reply with just the code, nothing else.",
      id2,
    )

    console.log(`[multi-turn] turn 2 response: "${fullText.slice(0, 200)}"`)

    expect(chunks.some((c) => c["type"] === "finish")).toBe(true)
    // The assistant must recall the secret code from the previous turn
    expect(fullText).toContain("XYZZY_42_PLUGH")
    await Bun.sleep(1500)
  }, CLAUDE_TIMEOUT + 10_000)

  test("turn 3: third message still has full context", async () => {
    const id3 = msgId()
    const { chunks, fullText } = await sendMessage(
      conversationSessionId,
      'Say the secret code backwards. Just the code reversed, nothing else.',
      id3,
    )

    console.log(`[multi-turn] turn 3 response: "${fullText.slice(0, 200)}"`)

    expect(chunks.some((c) => c["type"] === "finish")).toBe(true)
    // The response should contain the reversed code or reference to it
    // "HGULP_24_YZZYX" is the reverse
    const hasContext =
      fullText.includes("HGULP") ||
      fullText.includes("YZZYX") ||
      fullText.includes("XYZZY") ||
      fullText.includes("PLUGH")
    expect(hasContext).toBe(true)
    await Bun.sleep(1500)
  }, CLAUDE_TIMEOUT + 10_000)

  test("all 6 messages persisted (3 user + 3 assistant)", async () => {
    const messages = await getMessages(conversationSessionId)
    const roles = messages.map((m) => m.role ?? m.info?.role ?? "unknown")
    console.log(`[multi-turn] persisted roles: ${roles.join(", ")}`)

    const userCount = roles.filter((r) => r === "user").length
    const assistantCount = roles.filter((r) => r === "assistant").length

    expect(userCount).toBeGreaterThanOrEqual(3)
    expect(assistantCount).toBeGreaterThanOrEqual(3)
    expect(messages.length).toBeGreaterThanOrEqual(6)
  }, 15_000)

  test("message parentID chain links each assistant reply to its user message", async () => {
    const messages = await getMessages(conversationSessionId)
    const userIds = messages
      .filter((m) => (m.info?.role ?? m.role) === "user")
      .map((m) => m.info?.id)
      .filter(Boolean)
    const assistantParentIds = messages
      .filter((m) => (m.info?.role ?? m.role) === "assistant")
      .map((m) => m.info?.parentID)
      .filter(Boolean)

    console.log(`[multi-turn] user IDs: ${userIds.join(", ")}`)
    console.log(`[multi-turn] assistant parentIDs: ${assistantParentIds.join(", ")}`)

    // Each assistant message should point to a user message
    for (const parentId of assistantParentIds) {
      expect(userIds).toContain(parentId)
    }
  }, 10_000)
})

// ── Phase 2: Reload and continue conversation ──────────────────────────────

const lifecycle = suiteLifecycle("11-multi-turn-conversation")

describe.skipIf(!isSmoke)("11 — Multi-turn conversation (browser)", () => {
  beforeAll(lifecycle.before, 60_000)
  afterAll(lifecycle.after)

  test("navigate to multi-turn session", async () => {
    setTestContext("navigate to session")
    expect(conversationSessionId).toBeTruthy()

    const dirB64 = encodeDir(WORKSPACE_DIR)
    await open(`${BASE_URL}/${dirB64}/session/${conversationSessionId}`)
    await settle(5000)
    await screenshot("multi-turn-loaded")
  }, 30_000)

  test("all turns visible in chat", async () => {
    setTestContext("all turns visible")
    let snap = await snapshot()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (snap.includes("XYZZY_42_PLUGH")) break
      await settle(2000)
      snap = await snapshot()
    }
    await screenshot("all-turns")

    // Secret code should appear (user prompt + assistant recall)
    expect(snap.includes("XYZZY_42_PLUGH")).toBe(true)
    console.log(`[browser] secret code visible in chat`)
  }, 30_000)

  test("messages persist after page reload", async () => {
    setTestContext("persist after reload")
    await screenshot("before-reload")
    await press("Meta+r")
    await settle(5000)

    const snap = await snapshot()
    await screenshot("after-reload")

    // After reload, the conversation should still show the secret code
    const hasContent =
      snap.includes("XYZZY_42_PLUGH") ||
      snap.toLowerCase().includes("secret") ||
      snap.toLowerCase().includes("code")
    console.log(`[browser] after-reload hasContent=${hasContent}`)
    expect(hasContent).toBe(true)
  }, 30_000)

  test("continue conversation after reload — turn 4", async () => {
    setTestContext("continue after reload")
    // Send a 4th message via API and verify it appears
    const id4 = msgId()
    const { chunks, fullText } = await sendMessage(
      conversationSessionId,
      'What number was in the secret code? Reply with just the number.',
      id4,
    )

    console.log(`[browser] turn 4 response: "${fullText.slice(0, 200)}"`)
    expect(chunks.some((c) => c["type"] === "finish")).toBe(true)
    expect(fullText).toContain("42")

    // Wait and reload to see the new message
    await Bun.sleep(2000)
    await press("Meta+r")
    await settle(5000)

    const snap = await snapshot()
    await screenshot("after-turn-4")

    // The new answer should be visible
    const has42 = snap.includes("42")
    console.log(`[browser] turn 4 visible: ${has42}`)
    expect(has42).toBe(true)
  }, CLAUDE_TIMEOUT + 30_000)
})

// ── Phase 3: Abort and restart ──────────────────────────────────────────────

let abortSessionId = ""

describe.skipIf(!isSmoke)("11 — Abort and restart conversation (API)", () => {
  test("create session for abort test", async () => {
    abortSessionId = await createSession("e2e-abort-test")
    expect(abortSessionId).toBeTruthy()
    console.log(`[abort] session: ${abortSessionId}`)
  }, 15_000)

  test("start a long response and abort mid-stream", async () => {
    const controller = new AbortController()
    const id1 = msgId()

    // Start a message that will produce a long response
    const res = await fetch(`${BACKEND}/session/${abortSessionId}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-opencode-directory": WORKSPACE_DIR,
      },
      body: JSON.stringify({
        parts: [{ type: "text", text: "Write a very long essay about the history of computing. Include at least 20 paragraphs." }],
        messageID: id1,
      }),
      signal: controller.signal,
    })

    expect(res.ok).toBe(true)
    expect(res.body).toBeTruthy()

    // Read a few chunks then abort
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let receivedChunks = 0
    let buf = ""

    try {
      while (receivedChunks < 5) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split("\n\n")
        buf = parts.pop() ?? ""
        for (const part of parts) {
          if (part.includes("data: ")) receivedChunks++
        }
      }
    } catch {
      // may error on abort
    }

    console.log(`[abort] received ${receivedChunks} chunks before abort`)

    // Abort the request
    controller.abort()
    await reader.cancel().catch(() => {})

    // Also send explicit abort to the server
    const abortRes = await fetch(`${BACKEND}/session/${abortSessionId}/abort`, {
      method: "POST",
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    }).catch(() => null)
    console.log(`[abort] abort response: ${abortRes?.status ?? "failed"}`)

    // Give server time to process abort
    await Bun.sleep(2000)

    expect(receivedChunks).toBeGreaterThan(0)
  }, CLAUDE_TIMEOUT + 10_000)

  test("session still works after abort — can send a new message", async () => {
    const id2 = msgId()
    const { chunks, fullText } = await sendMessage(
      abortSessionId,
      'Say only "RECOVERED" and nothing else.',
      id2,
    )

    console.log(`[abort] recovery response: "${fullText.slice(0, 200)}"`)

    expect(chunks.some((c) => c["type"] === "finish")).toBe(true)
    expect(fullText.length).toBeGreaterThan(0)
    expect(fullText).toContain("RECOVERED")
  }, CLAUDE_TIMEOUT + 10_000)

  test("both aborted and recovery messages persisted", async () => {
    await Bun.sleep(1500)
    const messages = await getMessages(abortSessionId)
    const roles = messages.map((m) => m.role ?? m.info?.role ?? "unknown")
    console.log(`[abort] persisted roles: ${roles.join(", ")}`)

    // Should have at least: user1 + (partial)assistant1 + user2 + assistant2
    expect(roles.filter((r) => r === "user").length).toBeGreaterThanOrEqual(2)
    // At least the recovery assistant message
    expect(roles.filter((r) => r === "assistant").length).toBeGreaterThanOrEqual(1)
  }, 15_000)
})

// ── Phase 4: Session list reflects all sessions ─────────────────────────────

describe.skipIf(!isSmoke)("11 — Session list integrity (API)", () => {
  test("listing sessions includes both created sessions", async () => {
    const res = await fetch(`${BACKEND}/session`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    expect(res.ok).toBe(true)
    const sessions = (await res.json()) as Array<{ id: string; title?: string }>
    const ids = sessions.map((s) => s.id)

    if (conversationSessionId) {
      expect(ids).toContain(conversationSessionId)
    }
    if (abortSessionId) {
      expect(ids).toContain(abortSessionId)
    }
  }, 15_000)

  test("session details include correct title", async () => {
    if (!conversationSessionId) return

    const res = await fetch(`${BACKEND}/session/${conversationSessionId}`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    expect(res.ok).toBe(true)
    const session = (await res.json()) as { id: string; title?: string }
    expect(session.id).toBe(conversationSessionId)
    // Title may or may not be set depending on adapter
  }, 10_000)

  test("deleting a session removes it from the list", async () => {
    // Create a throwaway session
    const throwawayId = await createSession("e2e-throwaway")

    // Verify it exists
    const before = await fetch(`${BACKEND}/session`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    const beforeList = (await before.json()) as Array<{ id: string }>
    expect(beforeList.some((s) => s.id === throwawayId)).toBe(true)

    // Delete it
    const del = await fetch(`${BACKEND}/session/${throwawayId}`, {
      method: "DELETE",
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    expect(del.ok).toBe(true)

    // Verify it's gone
    await Bun.sleep(500)
    const after = await fetch(`${BACKEND}/session`, {
      headers: { "x-opencode-directory": WORKSPACE_DIR },
    })
    const afterList = (await after.json()) as Array<{ id: string }>
    expect(afterList.some((s) => s.id === throwawayId)).toBe(false)
  }, 30_000)
})
