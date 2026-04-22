/**
 * Cross-pane + review-parity integration test for the browser-tab feature.
 *
 * This test exercises the **full** producer→consumer→submit seam that Unit 8
 * is chartered to lock in:
 *
 *   1. A session consumer registers for BOTH `comment:receive` (review) AND
 *      `page-comment:receive` (browser). Both payloads route correctly, and
 *      neither channel contaminates the other.
 *   2. A browser producer firing `sendPageComment` lands the payload in the
 *      claxedo-owned `useBrowserComments` store keyed by sessionId.
 *   3. `useBrowserComments().pending(sessionId)` then feeds the
 *      `buildRequestParts` override, producing the expected synthetic text
 *      + image parts appended after upstream parts.
 *
 * Unlike `browser-pane.test.ts`, which stops at the pane-bus contract, this
 * test follows the payload all the way through the submit-time adapter that
 * the LLM actually sees.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt, ImageAttachmentPart } from "@/context/prompt"
import {
  _reset,
  bind,
  register,
  sendComment,
  sendPageComment,
} from "../../claxedo-ui/context/pane-bus"
import type {
  CommentPayload,
  PageElementCommentPayload,
} from "../../claxedo-ui/context/pane-bus"
import { formatElementCommentNote } from "../utils/format-element-comment-note"
import type { PageElementComment } from "../store/browser-comments"

// We simulate the claxedo-owned useBrowserComments store with a plain Map so
// the test does not pull in SolidJS provider machinery. The important
// invariants are: (a) pending() returns entries for the given sessionId,
// (b) clearPending drains them, (c) results feed the build-request-parts
// override.
type FakeStore = {
  items: PageElementComment[]
  enqueue: (sessionId: string, payload: PageElementCommentPayload) => PageElementComment
  pending: (sessionId: string) => PageElementComment[]
  clearPending: (sessionId: string) => void
}

function createFakeStore(): FakeStore {
  let seq = 1
  const items: PageElementComment[] = []
  return {
    items,
    enqueue(sessionId, payload) {
      const entry: PageElementComment = {
        id: `pec-${seq++}`,
        tabId: payload.tabId,
        sessionId,
        pageUrl: payload.pageUrl,
        selector: payload.selector,
        comment: payload.comment,
        noteText: payload.noteText,
        boundingBox: payload.boundingBox,
        outerHTML: payload.outerHTML,
        screenshotDataUrl: payload.screenshotDataUrl,
        createdAt: Date.now() + seq,
      }
      items.push(entry)
      return entry
    },
    pending(sessionId) {
      return items
        .filter((e) => e.sessionId === sessionId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    clearPending(sessionId) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].sessionId === sessionId) items.splice(i, 1)
      }
    },
  }
}

// Bridge the fake store into the override via the same `mock.module` path
// that build-request-parts.test.ts uses.
let fakeStore: FakeStore = createFakeStore()
mock.module("../store/browser-comments", () => ({
  useBrowserComments: () => ({
    pending: (sid: string) => fakeStore.pending(sid),
    list: (tid: string) => fakeStore.items.filter((e) => e.tabId === tid),
    add: (e: PageElementComment) => e,
    enqueue: (sid: string, p: PageElementCommentPayload) => fakeStore.enqueue(sid, p),
    remove: () => undefined,
    update: () => undefined,
    clearPending: (sid: string) => fakeStore.clearPending(sid),
    ready: () => true,
  }),
  BrowserCommentsProvider: () => null,
}))

const basePrompt: Prompt = [{ type: "text", content: "hi", start: 0, end: 2 }]
const emptyImages: ImageAttachmentPart[] = []

const loadOverride = async () => {
  // Query-string cache-bust so that mock.module takes effect for this run.
  const mod = await import(
    `../../overrides/components/prompt-input/build-request-parts?v=${Date.now()}-${Math.random()}`
  )
  return mod as typeof import("../../overrides/components/prompt-input/build-request-parts")
}

describe("cross-pane + review-parity (browser + comment consumers)", () => {
  beforeEach(() => {
    _reset()
    fakeStore = createFakeStore()
  })

  test("session consumer bound for both comment:receive and page-comment:receive receives both payloads independently", () => {
    const fileComments: CommentPayload[] = []
    const pageComments: PageElementCommentPayload[] = []

    // Browser producer (page-comment).
    register({
      leafId: "browser",
      tabId: "tab-1",
      type: "browser",
      name: () => "Browser",
      capabilities: ["page-comment:produce"],
      handlers: { "page-comment:produce": {} },
    })
    // Review producer (comment).
    register({
      leafId: "review",
      tabId: "tab-1",
      type: "review",
      name: () => "Review",
      capabilities: ["comment:produce"],
      handlers: {
        "comment:produce": {},
      },
    })
    // Session consumer — registers BOTH capabilities. This is the production
    // shape for a session pane sharing a tab with both review and browser
    // producers.
    register({
      leafId: "session",
      tabId: "tab-1",
      type: "session",
      name: () => "Session",
      capabilities: ["comment:receive", "page-comment:receive"],
      handlers: {
        "comment:receive": { onComment: (p) => fileComments.push(p) },
        "page-comment:receive": { onPageComment: (p) => pageComments.push(p) },
      },
    })

    bind("comment", "review", "session")
    bind("page-comment", "browser", "session")

    // Send a review comment.
    const filePayload: CommentPayload = {
      type: "file",
      path: "src/foo.ts",
      comment: "rename this",
    }
    expect(sendComment("review", filePayload)).toBe(true)

    // Send a browser page-element comment.
    const pagePayload: PageElementCommentPayload = {
      tabId: "tab-1",
      pageUrl: "https://ex.com",
      selector: "#hero > h1",
      comment: "make it punchier",
      noteText: formatElementCommentNote({
        selector: "#hero > h1",
        pageUrl: "https://ex.com",
        comment: "make it punchier",
      }),
      screenshotDataUrl: "data:image/png;base64,AAAA",
    }
    expect(sendPageComment("browser", pagePayload)).toBe(true)

    // Review arm only gets the file payload.
    expect(fileComments).toHaveLength(1)
    expect(fileComments[0].path).toBe("src/foo.ts")
    // Page-comment arm only gets the page payload.
    expect(pageComments).toHaveLength(1)
    expect(pageComments[0].selector).toBe("#hero > h1")
  })

  test("producer firing sendPageComment only does NOT contaminate a bound review consumer's payload", () => {
    const fileComments: CommentPayload[] = []
    const pageComments: PageElementCommentPayload[] = []

    register({
      leafId: "browser",
      tabId: "tab-1",
      type: "browser",
      name: () => "Browser",
      capabilities: ["page-comment:produce"],
      handlers: { "page-comment:produce": {} },
    })
    register({
      leafId: "session",
      tabId: "tab-1",
      type: "session",
      name: () => "Session",
      capabilities: ["comment:receive", "page-comment:receive"],
      handlers: {
        "comment:receive": { onComment: (p) => fileComments.push(p) },
        "page-comment:receive": { onPageComment: (p) => pageComments.push(p) },
      },
    })
    // Only the page-comment binding is set up — review is NOT bound to this
    // browser producer. A browser payload must never appear on the review
    // arm even though the consumer registered both.
    bind("page-comment", "browser", "session")

    sendPageComment("browser", {
      tabId: "tab-1",
      pageUrl: "u",
      selector: "s",
      comment: "c",
      noteText: "n",
    })

    expect(pageComments).toHaveLength(1)
    expect(fileComments).toHaveLength(0)
  })

  test("end-to-end: element pick → composer submit → pending(sessionId) → override buildRequestParts produces expected parts", async () => {
    // Stage the producer+consumer wiring.
    register({
      leafId: "browser",
      tabId: "tab-1",
      type: "browser",
      name: () => "Browser",
      capabilities: ["page-comment:produce"],
      handlers: { "page-comment:produce": {} },
    })
    register({
      leafId: "session",
      tabId: "tab-1",
      type: "session",
      name: () => "Session",
      capabilities: ["page-comment:receive"],
      handlers: {
        "page-comment:receive": {
          onPageComment: (p) => {
            fakeStore.enqueue("sess-xyz", p)
          },
        },
      },
    })
    bind("page-comment", "browser", "session")

    // Simulate the user picking an element and submitting a comment.
    const noteText = formatElementCommentNote({
      selector: "button.cta",
      pageUrl: "https://ex.com/landing",
      comment: "bigger pls",
    })
    sendPageComment("browser", {
      tabId: "tab-1",
      pageUrl: "https://ex.com/landing",
      selector: "button.cta",
      comment: "bigger pls",
      noteText,
      outerHTML: "<button class=\"cta\">Sign up</button>",
      screenshotDataUrl: "data:image/png;base64,BBBB",
    })

    // The session's handler enqueued into useBrowserComments, so pending()
    // now has exactly one entry for this session.
    expect(fakeStore.pending("sess-xyz")).toHaveLength(1)

    // Run the override. It should read the pending entry and produce the
    // expected synthetic text + image parts after upstream parts.
    const override = await loadOverride()
    const out = override.buildRequestParts({
      prompt: basePrompt,
      context: [],
      images: emptyImages,
      text: "hi",
      messageID: "msg-1",
      sessionID: "sess-xyz",
      sessionDirectory: "/repo",
    } as Parameters<typeof override.buildRequestParts>[0])

    // Expected shape: upstream contributes 1 text part; override appends
    // 1 synthetic text + 1 file (image) = 3 total.
    expect(out.requestParts).toHaveLength(3)
    const syntheticText = out.requestParts[1]
    const imagePart = out.requestParts[2]
    expect(syntheticText.type).toBe("text")
    expect(
      (syntheticText as { metadata?: { opencodeComment?: { origin?: string } } }).metadata
        ?.opencodeComment?.origin,
    ).toBe("browser")
    expect((syntheticText as { text: string }).text).toBe(noteText)
    expect(imagePart.type).toBe("file")
    expect((imagePart as { mime: string }).mime).toBe("image/png")
    expect((imagePart as { url: string }).url).toBe("data:image/png;base64,BBBB")
  })
})
