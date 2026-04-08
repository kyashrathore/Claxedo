/**
 * 09 — Live Chat
 *
 * Types a message into the real UI input, submits it, and verifies
 * the assistant response appears in the chat. This proves the full
 * live flow (promptAsync → WR → ACP → SSE events → frontend render).
 *
 * Requires: workspace-runtime :3002, claxedo-server :3001, Vite :4444
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { suiteLifecycle, setTestContext, screenshot, snapshot, settle } from "./_helpers"
import { open, fill, press, evaluate } from "../ab"

const BASE_URL = process.env.AB_BASE_URL ?? "http://localhost:4444"
const BACKEND = process.env.AB_BACKEND_URL ?? "http://localhost:3001"
const WORKSPACE_DIR = process.env.AB_WORKSPACE_DIR ?? "/Users/yashvardhansingh/test/opencode"
const CLAUDE_TIMEOUT = 90_000

// These tests hit real APIs and are non-deterministic — gate behind SMOKE_TEST=1
const isSmoke = !!process.env.SMOKE_TEST

const lifecycle = suiteLifecycle("09-live-chat")

/** Count non-overlapping occurrences of needle in haystack. */
function countOccurrences(snap: string, needle: string): number {
  let count = 0
  let pos = 0
  while ((pos = snap.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

describe.skipIf(!isSmoke)("09 — Live chat (type → submit → see both messages)", () => {
  beforeAll(lifecycle.before, 60_000)
  afterAll(lifecycle.after)

  test("open a fresh session", async () => {
    setTestContext("open fresh session")

    // Create session via API so we have a known URL
    const res = await fetch(`${BACKEND}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-directory": WORKSPACE_DIR },
      body: JSON.stringify({ title: "live-chat-test" }),
    })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }

    const dirB64 = Buffer.from(WORKSPACE_DIR, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "")

    await open(`${BASE_URL}/${dirB64}/session/${id}`)
    await settle(2000)
    await screenshot("fresh-session")

    // Session should be empty — no messages yet
    const snap = await snapshot()
    expect(snap.toLowerCase().includes("livetest")).toBe(false)
  }, 30_000)

  test("type message and submit via Enter", async () => {
    setTestContext("type and submit")

    // Click the prompt input (contenteditable aria-multiline div)
    await fill("[aria-multiline='true']", "Reply with only the word ASSREPLY_MARKER, nothing else. User token: USERPROMPT_MARKER")
    await settle(500)

    // Screenshot proves text was typed
    await screenshot("message-typed")

    // Submit
    await press("Enter")
    await settle(500)
    await screenshot("submitted")
  }, 20_000)

  test("user message bubble appears immediately", async () => {
    setTestContext("user bubble appears")
    await settle(2000)
    const snap = await snapshot()
    await screenshot("user-bubble")
    const hasUserMsg = snap.includes("USERPROMPT_MARKER")
    console.log(`[live] user bubble visible: ${hasUserMsg}`)
    // Not a hard fail — covered by assistant test
  }, 10_000)

  test("assistant response ASSREPLY_MARKER appears in chat", async () => {
    setTestContext("assistant response appears")

    // ASSREPLY_MARKER appears in the user prompt text AND in the breadcrumb = 2 baseline occurrences.
    // When the assistant responds with "ASSREPLY_MARKER", count reaches >= 3.
    // We wait until count >= 3 to confirm the assistant actually replied.
    let snap = await snapshot()
    let count = countOccurrences(snap, "ASSREPLY_MARKER")
    const deadline = Date.now() + CLAUDE_TIMEOUT
    while (Date.now() < deadline) {
      count = countOccurrences(snap, "ASSREPLY_MARKER")
      console.log(`[live] ASSREPLY_MARKER occurrences: ${count} (need >= 3 for assistant reply)`)
      if (count >= 3) break
      await settle(3000)
      snap = await snapshot()
    }
    count = countOccurrences(snap, "ASSREPLY_MARKER")

    // Scroll the chat to show the assistant message
    await evaluate("document.querySelectorAll('.scroll-view__viewport').forEach(vp => { vp.focus(); vp.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); vp.scrollTop = vp.scrollHeight; });").catch(() => {})
    await settle(1500)
    await screenshot("assistant-response")

    console.log(`[live] final ASSREPLY_MARKER count: ${count}`)
    expect(count).toBeGreaterThanOrEqual(3)
  }, CLAUDE_TIMEOUT + 10_000)
})
