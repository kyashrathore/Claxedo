import { describe, expect, test } from "bun:test"
import {
  createPromptTimelineReconciliation,
  isPageCommentPath,
  preparePromptRequest,
} from "./prepare-request"
import type { ImageAttachmentPart, Prompt } from "@/features/session/providers/prompt"
import type { PromptContextItem } from "./types"

// Rubric T2: per-phase test for prepare-request.ts. The unit covers:
//   - isPageCommentPath classifier (URL / "page" sentinel / file path)
//   - preparePromptRequest: message id generation, page-comment text
//     injection, submitted-comment rollback context
//   - createPromptTimelineReconciliation: returns batched add/remove/replyAdd
//     hooks that route through the supplied optimistic store

const emptyPrompt: Prompt = []

describe("isPageCommentPath", () => {
  test("matches http and https URLs and the 'page' sentinel", () => {
    expect(isPageCommentPath("http://example.com/article")).toBe(true)
    expect(isPageCommentPath("https://example.com")).toBe(true)
    expect(isPageCommentPath("page")).toBe(true)
  })

  test("rejects file paths, anchors, and unrelated strings", () => {
    expect(isPageCommentPath("/repo/src/index.ts")).toBe(false)
    expect(isPageCommentPath("ftp://example.com")).toBe(false)
    expect(isPageCommentPath("Page")).toBe(false)
    expect(isPageCommentPath("hidden/page")).toBe(false)
  })

  test("treats undefined / empty as non-page", () => {
    expect(isPageCommentPath(undefined)).toBe(false)
    expect(isPageCommentPath("")).toBe(false)
  })
})

describe("preparePromptRequest", () => {
  test("generates a stable message id and includes plain text", () => {
    const result = preparePromptRequest({
      prompt: emptyPrompt,
      contextItems: [],
      images: [],
      text: "hello world",
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
    })
    expect(result.messageID).toMatch(/^msg_/)
    expect(result.requestParts.some((p) => p.type === "text" && p.text === "hello world")).toBe(true)
    expect(result.submittedCommentItems).toEqual([])
  })

  test("rubric: page-comment context items become text parts, not file:// attachments", () => {
    const pageItem: PromptContextItem = {
      key: "page:abc",
      type: "file",
      path: "https://docs.example.com/article",
      comment: "User said: this paragraph is wrong",
    } as never
    const result = preparePromptRequest({
      prompt: emptyPrompt,
      contextItems: [pageItem],
      images: [],
      text: "",
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
    })
    const textParts = result.requestParts.filter((p) => p.type === "text")
    expect(
      textParts.some((p) => (p as { text: string }).text === "User said: this paragraph is wrong"),
    ).toBe(true)
    // Crucially: NO file part with a `file://http(s)://...` path
    expect(
      result.requestParts.some((p) => p.type === "file" && (p as { url?: string }).url?.includes("file://http")),
    ).toBe(false)
    expect(result.submittedCommentItems.some((item) => item.path === "https://docs.example.com/article")).toBe(true)
  })

  test("page-comment items with whitespace-only comments are skipped", () => {
    const pageItem: PromptContextItem = {
      key: "page:abc",
      type: "file",
      path: "https://docs.example.com/article",
      comment: "   ",
    } as never
    const result = preparePromptRequest({
      prompt: emptyPrompt,
      contextItems: [pageItem],
      images: [],
      text: "",
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
    })
    // The page item still goes into submittedCommentItems for the rollback
    // path to know which items were submitted, but no synthetic text part is
    // appended since the comment was empty.
    expect(
      result.requestParts.filter(
        (p) => p.type === "text" && (p as { text: string }).text.trim().length > 0,
      ),
    ).toHaveLength(0)
    // The empty page item is preserved in `submittedCommentItems` for
    // rollback context (still in pageCommentItems list).
    expect(result.submittedCommentItems).toHaveLength(1)
  })

  test("non-page file items with comments are tracked in submittedCommentItems", () => {
    const fileItem: PromptContextItem = {
      key: "file:src",
      type: "file",
      path: "/repo/src/index.ts",
      comment: "this method is broken",
    } as never
    const result = preparePromptRequest({
      prompt: emptyPrompt,
      contextItems: [fileItem],
      images: [],
      text: "",
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
    })
    expect(result.submittedCommentItems.some((item) => item.path === "/repo/src/index.ts")).toBe(true)
  })

  test("optimistic parts mirror request parts plus a sessionID/messageID stamp", () => {
    const result = preparePromptRequest({
      prompt: emptyPrompt,
      contextItems: [],
      images: [] as ImageAttachmentPart[],
      text: "hi",
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
    })
    expect(result.optimisticParts.length).toBeGreaterThanOrEqual(1)
    for (const part of result.optimisticParts) {
      expect((part as { sessionID?: string }).sessionID).toBe("ses_1")
      expect((part as { messageID?: string }).messageID).toBe(result.messageID)
    }
  })
})

describe("createPromptTimelineReconciliation", () => {
  test("addSubmittedPrompt routes through the optimistic store with the prepared parts", () => {
    const adds: Array<{ messageID: string; partsCount: number }> = []
    const reconcile = createPromptTimelineReconciliation({
      optimistic: {
        add: (input) => {
          adds.push({ messageID: input.message.id, partsCount: input.parts.length })
        },
        remove: () => undefined,
      },
      promptRequest: {
        messageID: "msg_42",
        requestParts: [],
        optimisticParts: [
          { id: "p1", type: "text", text: "hi", sessionID: "ses_1", messageID: "msg_42" } as never,
          { id: "p2", type: "text", text: "more", sessionID: "ses_1", messageID: "msg_42" } as never,
        ],
        submittedCommentItems: [],
      },
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
      agent: "build",
      model: { providerID: "anthropic", modelID: "sonnet" },
    })
    reconcile.addSubmittedPrompt()
    expect(adds).toEqual([{ messageID: "msg_42", partsCount: 2 }])
  })

  test("removeSubmittedPrompt routes through the optimistic store with the prepared messageID", () => {
    const removes: string[] = []
    const reconcile = createPromptTimelineReconciliation({
      optimistic: {
        add: () => undefined,
        remove: (input) => {
          removes.push(input.messageID)
        },
      },
      promptRequest: {
        messageID: "msg_99",
        requestParts: [],
        optimisticParts: [],
        submittedCommentItems: [],
      },
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
      agent: "build",
      model: { providerID: "anthropic", modelID: "sonnet" },
    })
    reconcile.removeSubmittedPrompt()
    expect(removes).toEqual(["msg_99"])
  })

  test("addDemoReply uses the reply's message + parts (not the prepared ones)", () => {
    const adds: Array<{ messageID: string; partsCount: number }> = []
    const reconcile = createPromptTimelineReconciliation({
      optimistic: {
        add: (input) => {
          adds.push({ messageID: input.message.id, partsCount: input.parts.length })
        },
        remove: () => undefined,
      },
      promptRequest: {
        messageID: "msg_user",
        requestParts: [],
        optimisticParts: [],
        submittedCommentItems: [],
      },
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
      agent: "build",
      model: { providerID: "anthropic", modelID: "sonnet" },
    })
    reconcile.addDemoReply({
      info: { id: "msg_assistant", role: "assistant", sessionID: "ses_1", time: { created: 1 } } as never,
      parts: [{ id: "p1", type: "text", text: "demo", sessionID: "ses_1", messageID: "msg_assistant" } as never],
    })
    expect(adds).toEqual([{ messageID: "msg_assistant", partsCount: 1 }])
  })

  test("variant is propagated into the submitted message model", () => {
    let captured: { model?: { variant?: string } } | undefined
    const reconcile = createPromptTimelineReconciliation({
      optimistic: {
        add: (input) => {
          captured = input.message as never
        },
        remove: () => undefined,
      },
      promptRequest: {
        messageID: "msg_v",
        requestParts: [],
        optimisticParts: [],
        submittedCommentItems: [],
      },
      sessionID: "ses_1",
      sessionDirectory: "/repo/main",
      agent: "build",
      model: { providerID: "anthropic", modelID: "sonnet" },
      variant: "thinking",
    })
    reconcile.addSubmittedPrompt()
    expect(captured?.model?.variant).toBe("thinking")
  })
})
