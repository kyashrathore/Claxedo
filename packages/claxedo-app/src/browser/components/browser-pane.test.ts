/**
 * Integration-style tests for the browser pane's element-comment pipeline.
 *
 * We don't mount the full SolidJS component tree (that's what the `.vitest`
 * variant would cover). Instead we verify the three contracts that matter
 * most for Unit 6:
 *
 *  1. The `page-comment:produce` / `page-comment:receive` capability pair
 *     exists on the pane bus and routes `PageElementCommentPayload` values.
 *  2. A consumer pane that only registered `comment:receive` does NOT get
 *     `PageElementCommentPayload` values — the two channels are disjoint.
 *  3. End-to-end: formatElementCommentNote → sendPageComment → consumer
 *     handler fires with the full payload including screenshot.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import {
  _reset,
  autoBind,
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

describe("browser pane element-comment pipeline", () => {
  beforeEach(() => {
    _reset()
  })

  test("sendPageComment routes to bound consumer via page-comment binding", () => {
    const received: PageElementCommentPayload[] = []

    register({
      leafId: "producer",
      tabId: "tab-1",
      type: "browser",
      name: () => "Browser",
      capabilities: ["page-comment:produce"],
      handlers: {
        "page-comment:produce": {},
      },
    })
    register({
      leafId: "consumer",
      tabId: "tab-1",
      type: "session",
      name: () => "Session",
      capabilities: ["page-comment:receive"],
      handlers: {
        "page-comment:receive": {
          onPageComment: (p) => received.push(p),
        },
      },
    })
    bind("page-comment", "producer", "consumer")

    const payload: PageElementCommentPayload = {
      tabId: "tab-1",
      pageUrl: "https://ex.com",
      selector: "button.primary",
      comment: "brighter please",
      noteText: "note",
      outerHTML: "<button/>",
      screenshotDataUrl: "data:image/png;base64,X",
    }
    const ok = sendPageComment("producer", payload)
    expect(ok).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0]).toEqual(payload)
  })

  test("autoBind on page-comment:receive matches a single sibling consumer", () => {
    register({
      leafId: "producer",
      tabId: "tab-1",
      type: "browser",
      name: () => "Browser",
      capabilities: ["page-comment:produce"],
      handlers: { "page-comment:produce": {} },
    })
    const received: PageElementCommentPayload[] = []
    register({
      leafId: "the-session",
      tabId: "tab-1",
      type: "session",
      name: () => "Session",
      capabilities: ["page-comment:receive"],
      handlers: {
        "page-comment:receive": {
          onPageComment: (p) => received.push(p),
        },
      },
    })
    autoBind("producer", "page-comment", "page-comment:receive")

    const ok = sendPageComment("producer", {
      tabId: "tab-1",
      pageUrl: "u",
      selector: "s",
      comment: "c",
      noteText: "n",
    })
    expect(ok).toBe(true)
    expect(received).toHaveLength(1)
  })

  test("a consumer that only registered comment:receive does NOT receive page-comment payloads", () => {
    const fileComments: CommentPayload[] = []
    const pageComments: PageElementCommentPayload[] = []

    register({
      leafId: "producer",
      tabId: "tab-1",
      type: "browser",
      name: () => "Browser",
      capabilities: ["page-comment:produce"],
      handlers: { "page-comment:produce": {} },
    })
    register({
      leafId: "review-only-consumer",
      tabId: "tab-1",
      type: "session",
      name: () => "Session",
      capabilities: ["comment:receive"],
      handlers: {
        "comment:receive": {
          onComment: (p) => fileComments.push(p),
        },
      },
    })

    // No `page-comment:receive` consumer exists. autoBind must not resolve,
    // sendPageComment must return false, and the review consumer must not
    // see anything.
    autoBind("producer", "page-comment", "page-comment:receive")
    const ok = sendPageComment("producer", {
      tabId: "tab-1",
      pageUrl: "u",
      selector: "s",
      comment: "c",
      noteText: "n",
    })
    expect(ok).toBe(false)
    expect(pageComments).toHaveLength(0)
    expect(fileComments).toHaveLength(0)

    // Verify the legacy comment channel still works — page-comment extension
    // must not have broken existing review flows.
    bind("comment", "producer", "review-only-consumer")
    const ok2 = sendComment("producer", {
      type: "file",
      path: "src/x.ts",
      comment: "fix",
    })
    expect(ok2).toBe(true)
    expect(fileComments).toHaveLength(1)
  })

  test("formatElementCommentNote rides on the payload sent through the bus", () => {
    const received: PageElementCommentPayload[] = []
    register({
      leafId: "browser",
      tabId: "t",
      type: "browser",
      name: () => "Browser",
      capabilities: ["page-comment:produce"],
      handlers: { "page-comment:produce": {} },
    })
    register({
      leafId: "session",
      tabId: "t",
      type: "session",
      name: () => "Session",
      capabilities: ["page-comment:receive"],
      handlers: {
        "page-comment:receive": { onPageComment: (p) => received.push(p) },
      },
    })
    bind("page-comment", "browser", "session")

    const comment = "make it pop"
    const noteText = formatElementCommentNote({
      selector: "#hero > button",
      pageUrl: "https://ex.com/landing",
      comment,
    })
    sendPageComment("browser", {
      tabId: "t",
      pageUrl: "https://ex.com/landing",
      selector: "#hero > button",
      comment,
      noteText,
    })

    expect(received).toHaveLength(1)
    expect(received[0].noteText).toBe(noteText)
    expect(received[0].noteText).toContain("make it pop")
    expect(received[0].noteText).toContain("#hero > button")
  })
})
