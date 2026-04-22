/**
 * Contract tests for the claxedo override of `build-request-parts`.
 *
 *  1. With `useBrowserComments().pending(sessionID) === []`, the output is
 *     **byte-identical** to upstream's function (the override is a no-op).
 *  2. With one pending browser comment, the override appends exactly two
 *     parts (text + image) after upstream's parts, in `createdAt` order.
 *  3. A mix of upstream `prompt.context.items` and pending browser comments
 *     preserves upstream order; browser comments always come last.
 *
 * The tests mock `useBrowserComments` so we don't load the full
 * Persist.global / SolidJS provider machinery.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { Prompt, FileAttachmentPart, ImageAttachmentPart } from "@/context/prompt"
import type { PageElementComment } from "../../../browser/store/browser-comments"

let pendingComments: PageElementComment[] = []

mock.module("../../../browser/store/browser-comments", () => ({
  useBrowserComments: () => ({
    pending: (_sid: string) => pendingComments,
    list: () => pendingComments,
    add: (e: any) => e,
    enqueue: (_s: string, p: any) => p,
    remove: () => undefined,
    update: () => undefined,
    clearPending: () => undefined,
    ready: () => true,
  }),
  BrowserCommentsProvider: () => null,
}))

const emptyPrompt: Prompt = [{ type: "text", content: "hello", start: 0, end: 5 }]
const emptyImages: ImageAttachmentPart[] = []

const loadOverride = async () => {
  const mod = await import(`./build-request-parts?v=${Date.now()}-${Math.random()}`)
  return mod as typeof import("./build-request-parts")
}

const loadUpstream = async () => {
  const mod = await import(
    `../../../../../app/src/components/prompt-input/build-request-parts?v=${Date.now()}-${Math.random()}`
  )
  return mod as typeof import("../../../../../app/src/components/prompt-input/build-request-parts")
}

describe("buildRequestParts override", () => {
  beforeEach(() => {
    pendingComments = []
  })

  test("empty pending queue → byte-identical to upstream output", async () => {
    const override = await loadOverride()
    const upstream = await loadUpstream()
    const input = {
      prompt: emptyPrompt,
      context: [],
      images: emptyImages,
      text: "hello",
      messageID: "msg-1",
      sessionID: "sess-1",
      sessionDirectory: "/repo",
    }

    // Note: `Identifier.ascending` is non-deterministic, so we compare
    // structural shape rather than `id`.
    const viaOverride = override.buildRequestParts(input as any)
    const viaUpstream = upstream.buildRequestParts(input as any)

    expect(viaOverride.requestParts.length).toBe(viaUpstream.requestParts.length)
    expect(viaOverride.optimisticParts.length).toBe(viaUpstream.optimisticParts.length)

    const strip = (parts: any[]) =>
      parts.map((p) => {
        const { id: _id, ...rest } = p
        return rest
      })

    expect(strip(viaOverride.requestParts)).toEqual(strip(viaUpstream.requestParts))
  })

  test("one pending browser comment → appends exactly two parts (text + image)", async () => {
    pendingComments = [
      {
        id: "pec-1",
        tabId: "tab-1",
        sessionId: "sess-1",
        pageUrl: "https://example.com",
        selector: "button.primary",
        comment: "style this",
        noteText: "note-1",
        outerHTML: "<button class=\"primary\">Hi</button>",
        screenshotDataUrl: "data:image/png;base64,AAAA",
        createdAt: 1,
      },
    ]

    const override = await loadOverride()
    const input = {
      prompt: emptyPrompt,
      context: [],
      images: emptyImages,
      text: "hello",
      messageID: "msg-1",
      sessionID: "sess-1",
      sessionDirectory: "/repo",
    }
    const out = override.buildRequestParts(input as any)

    // Upstream produces 1 text part; we append 2 more → 3 total.
    expect(out.requestParts).toHaveLength(3)
    const [baseText, syntheticText, imagePart] = out.requestParts

    expect(baseText.type).toBe("text")
    expect(syntheticText.type).toBe("text")
    expect(syntheticText.text).toBe("note-1")
    expect((syntheticText as any).synthetic).toBe(true)
    expect((syntheticText as any).metadata?.opencodeComment?.origin).toBe("browser")
    expect((syntheticText as any).metadata?.opencodeComment?.selector).toBe("button.primary")

    expect(imagePart.type).toBe("file")
    expect((imagePart as any).mime).toBe("image/png")
    expect((imagePart as any).url).toBe("data:image/png;base64,AAAA")

    // optimisticParts mirror structure.
    expect(out.optimisticParts).toHaveLength(3)
  })

  test("no screenshot on comment → only appends synthetic text part", async () => {
    pendingComments = [
      {
        id: "pec-2",
        tabId: "tab-1",
        sessionId: "sess-1",
        pageUrl: "u",
        selector: "s",
        comment: "c",
        noteText: "n",
        createdAt: 2,
      },
    ]

    const override = await loadOverride()
    const out = override.buildRequestParts({
      prompt: emptyPrompt,
      context: [],
      images: emptyImages,
      text: "hi",
      messageID: "msg-2",
      sessionID: "sess-1",
      sessionDirectory: "/repo",
    } as any)
    // Upstream 1 + synthetic 1 = 2.
    expect(out.requestParts).toHaveLength(2)
    expect(out.requestParts[1].type).toBe("text")
  })

  test("mix of upstream context items and pending browser comments → upstream parts first, browser comments last", async () => {
    pendingComments = [
      {
        id: "pec-3",
        tabId: "tab-1",
        sessionId: "sess-1",
        pageUrl: "https://site.example",
        selector: "#x",
        comment: "brow-1",
        noteText: "brow-note",
        screenshotDataUrl: "data:image/png;base64,ZZZ",
        createdAt: 3,
      },
    ]

    const fileAttachment: FileAttachmentPart = {
      type: "file",
      id: "att-1",
      path: "pkg/x/file.ts",
      content: "const a = 1\nconst b = 2",
      start: 0,
      end: 25,
    }

    const override = await loadOverride()
    const out = override.buildRequestParts({
      prompt: [{ type: "text", content: "hi", start: 0, end: 2 }, fileAttachment] as Prompt,
      context: [
        {
          key: "ctx-1",
          type: "file",
          path: "pkg/x/other.ts",
          comment: "please fix",
          commentID: "cmt-1",
          commentOrigin: "review",
        },
      ],
      images: emptyImages,
      text: "hi",
      messageID: "msg-3",
      sessionID: "sess-1",
      sessionDirectory: "/repo",
    } as any)

    // Verify: the LAST two parts are the browser comment's synthetic text
    // followed by its image. Upstream's file + context parts precede them.
    const last = out.requestParts[out.requestParts.length - 1]
    const secondLast = out.requestParts[out.requestParts.length - 2]

    expect(secondLast.type).toBe("text")
    expect((secondLast as any).text).toBe("brow-note")
    expect((secondLast as any).metadata?.opencodeComment?.origin).toBe("browser")

    expect(last.type).toBe("file")
    expect((last as any).url).toBe("data:image/png;base64,ZZZ")

    // Sanity: upstream still produced its own parts (base text + file
    // attachment + context file + synthetic comment-note). So expect at
    // least 4 upstream parts before our 2 browser parts.
    expect(out.requestParts.length).toBeGreaterThanOrEqual(6)
  })

  test("multiple pending browser comments → appended in createdAt order", async () => {
    pendingComments = [
      {
        id: "pec-a",
        tabId: "tab-1",
        sessionId: "sess-1",
        pageUrl: "u",
        selector: "s1",
        comment: "c1",
        noteText: "note-1",
        createdAt: 1,
      },
      {
        id: "pec-b",
        tabId: "tab-1",
        sessionId: "sess-1",
        pageUrl: "u",
        selector: "s2",
        comment: "c2",
        noteText: "note-2",
        createdAt: 2,
      },
    ]

    const override = await loadOverride()
    const out = override.buildRequestParts({
      prompt: emptyPrompt,
      context: [],
      images: emptyImages,
      text: "hi",
      messageID: "msg-x",
      sessionID: "sess-1",
      sessionDirectory: "/repo",
    } as any)

    // Upstream 1 + 2 synthetic = 3 total.
    expect(out.requestParts).toHaveLength(3)
    expect((out.requestParts[1] as any).text).toBe("note-1")
    expect((out.requestParts[2] as any).text).toBe("note-2")
  })
})
