/**
 * Browser-specific pane-bus contract tests (Unit 8).
 *
 * The generic `pane-bus.test.ts` already covers the shared bind/autoBind/
 * dispatch contracts. This file pins down the browser feature's two
 * user-facing paths:
 *
 *   1. **autoBind succeeds** when exactly one sibling session with
 *      `page-comment:receive` exists in the producer's tab → the producer's
 *      next `sendPageComment` routes without any user interaction.
 *   2. **autoBind is a no-op** when there are zero or multiple candidate
 *      session consumers → `sendPageComment` returns false until the user
 *      picks one (the "kebab picker" UX path in the renderer).
 *   3. **Cross-tab isolation**: a session in a different tab must never
 *      auto-bind — the producer must only consider same-tab siblings.
 *   4. **autoBind does not overwrite** an existing manual binding.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import {
  _reset,
  autoBind,
  bind,
  getBound,
  register,
  sendPageComment,
} from "./pane-bus"
import type { PageElementCommentPayload } from "./pane-bus"

function registerProducer(leafId: string, tabId: string) {
  register({
    leafId,
    tabId,
    type: "browser",
    name: () => "Browser",
    capabilities: ["page-comment:produce"],
    handlers: { "page-comment:produce": {} },
  })
}

function registerConsumer(leafId: string, tabId: string, sink: PageElementCommentPayload[]) {
  register({
    leafId,
    tabId,
    type: "session",
    name: () => "Session",
    capabilities: ["page-comment:receive"],
    handlers: {
      "page-comment:receive": { onPageComment: (p) => sink.push(p) },
    },
  })
}

const samplePayload = (overrides: Partial<PageElementCommentPayload> = {}): PageElementCommentPayload => ({
  tabId: "tab-1",
  pageUrl: "https://example.com",
  selector: "button.cta",
  comment: "bigger pls",
  noteText: "note",
  ...overrides,
})

describe("pane-bus: page-comment autoBind contract", () => {
  beforeEach(() => {
    _reset()
  })

  test("exactly one sibling consumer → autoBind succeeds and sendPageComment routes", () => {
    const received: PageElementCommentPayload[] = []
    registerProducer("browser", "tab-1")
    registerConsumer("session", "tab-1", received)

    autoBind("browser", "page-comment", "page-comment:receive")
    expect(getBound("page-comment", "browser")).toBe("session")

    const ok = sendPageComment("browser", samplePayload())
    expect(ok).toBe(true)
    expect(received).toHaveLength(1)
  })

  test("two sibling consumers → autoBind does NOT bind, sendPageComment returns false (kebab-picker path)", () => {
    const sinkA: PageElementCommentPayload[] = []
    const sinkB: PageElementCommentPayload[] = []
    registerProducer("browser", "tab-1")
    registerConsumer("session-a", "tab-1", sinkA)
    registerConsumer("session-b", "tab-1", sinkB)

    autoBind("browser", "page-comment", "page-comment:receive")
    expect(getBound("page-comment", "browser")).toBeNull()

    const ok = sendPageComment("browser", samplePayload())
    expect(ok).toBe(false)
    expect(sinkA).toHaveLength(0)
    expect(sinkB).toHaveLength(0)
  })

  test("after user picks a target via bind() the next sendPageComment routes", () => {
    const sinkA: PageElementCommentPayload[] = []
    const sinkB: PageElementCommentPayload[] = []
    registerProducer("browser", "tab-1")
    registerConsumer("session-a", "tab-1", sinkA)
    registerConsumer("session-b", "tab-1", sinkB)

    // User picks session-b via the kebab picker.
    bind("page-comment", "browser", "session-b")

    const ok = sendPageComment("browser", samplePayload())
    expect(ok).toBe(true)
    expect(sinkA).toHaveLength(0)
    expect(sinkB).toHaveLength(1)
  })

  test("zero consumers → autoBind does not bind, sendPageComment returns false", () => {
    registerProducer("browser", "tab-1")

    autoBind("browser", "page-comment", "page-comment:receive")
    expect(getBound("page-comment", "browser")).toBeNull()

    const ok = sendPageComment("browser", samplePayload())
    expect(ok).toBe(false)
  })

  test("cross-tab: sibling session in a different tab is NOT an autoBind candidate", () => {
    const sameTabSink: PageElementCommentPayload[] = []
    const otherTabSink: PageElementCommentPayload[] = []
    registerProducer("browser", "tab-1")
    registerConsumer("session-other", "tab-2", otherTabSink)
    registerConsumer("session-same", "tab-1", sameTabSink)

    autoBind("browser", "page-comment", "page-comment:receive")
    expect(getBound("page-comment", "browser")).toBe("session-same")

    sendPageComment("browser", samplePayload())
    expect(sameTabSink).toHaveLength(1)
    expect(otherTabSink).toHaveLength(0)
  })

  test("autoBind does not overwrite an existing manual binding", () => {
    const sinkA: PageElementCommentPayload[] = []
    const sinkB: PageElementCommentPayload[] = []
    registerProducer("browser", "tab-1")
    registerConsumer("session-a", "tab-1", sinkA)
    // Manual bind to A first.
    bind("page-comment", "browser", "session-a")

    // Now a second candidate joins the tab; autoBind must not kick in.
    registerConsumer("session-b", "tab-1", sinkB)
    autoBind("browser", "page-comment", "page-comment:receive")

    expect(getBound("page-comment", "browser")).toBe("session-a")
  })
})
