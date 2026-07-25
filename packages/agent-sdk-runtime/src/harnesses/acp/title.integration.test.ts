/**
 * Live integration test for ACP session title generation.
 *
 * Requires ANTHROPIC_API_KEY env var and the claude-agent-acp binary.
 * Run: ANTHROPIC_API_KEY=sk-... bun test src/adapters/acp/title.integration.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { AcpHarnessAdapter } from "./index"
import { createRuntimeEventHub } from "../../runtime-event-hub"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import type { AgentRuntimeStreamEvent } from "../../index"

const API_KEY = process.env.ANTHROPIC_API_KEY
const BINARY = path.resolve(import.meta.dirname, "../../../node_modules/.bin/claude-agent-acp")

describe.skipIf(!API_KEY)("ACP title generation (live)", () => {
  let adapter: AcpHarnessAdapter
  let tmpDir: string
  let storeDir: string
  const eventHub = createRuntimeEventHub()

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-title-test-"))
    storeDir = path.join(tmpDir, "store")
    fs.mkdirSync(storeDir, { recursive: true })

    adapter = new AcpHarnessAdapter({ binary: BINARY, storeRoot: storeDir, eventHub, env: { ANTHROPIC_API_KEY: API_KEY } })
  })

  afterAll(() => {
    try {
      adapter.dispose()
    } catch {}
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it("creates a session and generates a title after first message", async () => {
    // 1. Create session with no title
    const session = await adapter.createSession(tmpDir)
    expect(session.id).toBeTruthy()
    const sessionId = session.id

    // 2. Send a message — this should trigger auto-title
    const events: AgentRuntimeStreamEvent[] = []
    for await (const event of adapter.sendMessage(
      sessionId,
      {
        parts: [{ type: "text", text: "Write a fibonacci function in Python" }],
        assistantMessageId: `a_${Date.now()}`,
        agent: "developer",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      },
      tmpDir,
    )) {
      events.push(event)
    }

    // 3. Verify events include session.updated with a truncated title (immediate fallback)
    const titleEvents = events.filter((e) => e.type === "session.updated")
    expect(titleEvents.length).toBeGreaterThanOrEqual(1)
    const first = titleEvents[0]
    const firstTitle = first?.type === "session.updated" ? first.properties.info.title : undefined
    expect(firstTitle).toBeTruthy()
    expect(typeof firstTitle).toBe("string")
    console.log("[test] immediate title:", firstTitle)

    // 4. Verify session.idle was emitted
    expect(events.some((e) => e.type === "session.idle")).toBe(true)

    // 5. Wait for the async AI-generated title to arrive via global event bus
    const aiTitle = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 30_000)
      const unsub = eventHub.subscribeGlobal((envelope) => {
        const event = envelope.payload
        if (event.type === "session.updated" && event.properties?.info?.id === sessionId) {
          const title = event.properties.info.title
          // Only resolve if it's a different (AI-generated) title
          if (title && title !== firstTitle) {
            clearTimeout(timeout)
            unsub()
            resolve(title)
          }
        }
      })
    })

    if (aiTitle) {
      console.log("[test] AI-generated title:", aiTitle)
      expect(aiTitle.length).toBeGreaterThan(0)
      expect(aiTitle.length).toBeLessThanOrEqual(100)
    } else {
      console.log("[test] AI title generation timed out or produced same title (non-fatal)")
    }
  }, 60_000)

  it("does not generate title when session already has one", async () => {
    // 1. Create session with an explicit title
    const session = await adapter.createSession(tmpDir, "My Custom Title")
    const sessionId = session.id

    // 2. Send a message
    const events: AgentRuntimeStreamEvent[] = []
    for await (const event of adapter.sendMessage(
      sessionId,
      {
        parts: [{ type: "text", text: "Hello" }],
        assistantMessageId: `a_${Date.now()}`,
        agent: "developer",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      },
      tmpDir,
    )) {
      events.push(event)
    }

    // 3. No session.updated title event should be emitted
    const titleEvents = events.filter((e) => e.type === "session.updated")
    expect(titleEvents.length).toBe(0)
  }, 60_000)
})
