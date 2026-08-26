import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearSessionPrefetch,
  clearSessionPrefetchDirectory,
  getSessionPrefetchPromise,
  getSessionPrefetch,
  invalidateSessionPrefetchFromEvent,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  sessionHistoryPageRequest,
  SESSION_PREFETCH_FIRST_FOLD_MESSAGE_COUNT,
  setSessionPrefetch,
  splitSessionPrefetchPage,
  shouldSkipSessionPrefetch,
} from "./session-prefetch"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "./keys"

describe("session prefetch cache", () => {
  beforeEach(() => {
    queryClient.clear()
  })

  test("uses the bounded latest surface initially and unchanged cursor paging for older history", () => {
    expect(sessionHistoryPageRequest()).toEqual({
      view: "latest-surface",
    })
    expect(sessionHistoryPageRequest("cursor_older")).toEqual({
      before: "cursor_older",
      limit: 200,
    })
  })

  test("stores prefetched message pages in the shell query graph", () => {
    const message = { id: "msg_1", sessionID: "ses_1", role: "user" } as Message
    const part = { id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text" } as Part

    setSessionPrefetch({
      directory: "/repo",
      sessionID: "ses_1",
      limit: 1,
      complete: true,
      page: {
        messages: [message],
        parts: [{ id: "msg_1", part: [part] }],
      },
      at: 10,
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "message-prefetch", "/repo"))).toMatchObject({
      directory: "/repo",
      limit: 1,
      complete: true,
    })
    expect(getSessionPrefetch("/repo", "ses_1")).toMatchObject({
      limit: 1,
      complete: true,
      page: {
        messages: [message],
        parts: [{ id: "msg_1", part: [part] }],
      },
      at: 10,
    })
    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: getSessionPrefetch("/repo", "ses_1"),
        chunk: 200,
        now: 20,
      }),
    ).toBe(true)

    clearSessionPrefetch(["ses_1"])
    expect(getSessionPrefetch("/repo", "ses_1")).toBeUndefined()
  })

  test("splits a full prefetched page into an ordered first fold and deferred history without loss", () => {
    const messages = Array.from(
      { length: 12 },
      (_, index) =>
        ({
          id: `msg_${String(index).padStart(2, "0")}`,
          sessionID: "ses_split",
          role: index % 2 === 0 ? "user" : "assistant",
        }) as Message,
    )
    const parts = messages.map((message) => ({
      id: message.id,
      part: [{ id: `part_${message.id}`, messageID: message.id, sessionID: "ses_split", type: "text" } as Part],
    }))
    const split = splitSessionPrefetchPage({
      directory: "/repo",
      limit: messages.length,
      complete: false,
      cursor: "older-cursor",
      at: 10,
      page: { messages, parts },
    })!

    expect(split.firstFold.messages.map((message) => message.id)).toEqual(["msg_10", "msg_11"])
    expect([...split.deferred.messages, ...split.firstFold.messages].map((message) => message.id)).toEqual(
      messages.map((message) => message.id),
    )
    expect([...split.deferred.parts, ...split.firstFold.parts].map((row) => row.id)).toEqual(parts.map((row) => row.id))
  })

  test("keeps a multi-assistant latest turn within the first-fold budget", () => {
    const messages = [
      { id: "user", sessionID: "ses_turn", role: "user" },
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `assistant_${index}`,
        sessionID: "ses_turn",
        role: "assistant",
      })),
    ] as Message[]
    const split = splitSessionPrefetchPage({
      directory: "/repo",
      limit: messages.length,
      complete: true,
      at: 10,
      page: { messages, parts: [] },
    })!

    expect(split.firstFold.messages.map((message) => message.id)).toEqual(["user", "assistant_7"])
    expect(split.firstFold.messages).toHaveLength(SESSION_PREFETCH_FIRST_FOLD_MESSAGE_COUNT)
    expect([...split.deferred.messages, ...split.firstFold.messages].map((message) => message.id).sort()).toEqual(
      messages.map((message) => message.id).sort(),
    )
  })

  test("isolates duplicate session ids by directory", () => {
    setSessionPrefetch({
      directory: "/repo/a",
      sessionID: "ses_shared",
      limit: 1,
      complete: true,
      at: 10,
    })

    setSessionPrefetch({
      directory: "/repo/b",
      sessionID: "ses_shared",
      limit: 2,
      complete: false,
      at: 20,
    })

    expect(getSessionPrefetch("/repo/a", "ses_shared")).toMatchObject({
      directory: "/repo/a",
      limit: 1,
      complete: true,
    })
    expect(getSessionPrefetch("/repo/b", "ses_shared")).toMatchObject({
      directory: "/repo/b",
      limit: 2,
      complete: false,
    })

    clearSessionPrefetchDirectory("/repo/b")
    expect(getSessionPrefetch("/repo/a", "ses_shared")).toBeDefined()
    expect(getSessionPrefetch("/repo/b", "ses_shared")).toBeUndefined()
    clearSessionPrefetchDirectory("/repo/a")
    expect(getSessionPrefetch("/repo/a", "ses_shared")).toBeUndefined()
  })

  test("an authoritative event invalidates a prefetched snapshot exactly once", () => {
    setSessionPrefetch({
      directory: "/repo",
      sessionID: "ses_event",
      limit: 1,
      complete: true,
      page: { messages: [{ id: "msg_event", role: "user" } as Message], parts: [] },
    })

    setSessionPrefetch({
      directory: "/other",
      sessionID: "ses_event",
      limit: 1,
      complete: true,
    })

    expect(invalidateSessionPrefetchFromEvent("/repo", "ses_event")).toBe(true)
    expect(getSessionPrefetch("/repo", "ses_event")).toBeUndefined()
    expect(getSessionPrefetch("/other", "ses_event")).toBeDefined()
    expect(invalidateSessionPrefetchFromEvent("/repo", "ses_event")).toBe(false)
  })

  test("dedupes inflight work within one directory without crossing directories", async () => {
    let calls = 0
    const first = runSessionPrefetch({
      directory: "/repo/a",
      sessionID: "ses_inflight",
      task: async () => {
        calls += 1
        await Promise.resolve()
        return {
          directory: "/repo/a",
          limit: 1,
          complete: false,
          at: 10,
        }
      },
    })
    const duplicate = runSessionPrefetch({
      directory: "/repo/a",
      sessionID: "ses_inflight",
      task: async () => {
        calls += 1
        return undefined
      },
    })
    const otherDirectory = runSessionPrefetch({
      directory: "/repo/b",
      sessionID: "ses_inflight",
      task: async () => {
        calls += 1
        return {
          directory: "/repo/b",
          limit: 2,
          complete: true,
          at: 20,
        }
      },
    })

    expect(getSessionPrefetchPromise("/repo/a", "ses_inflight")).toBeDefined()
    expect(getSessionPrefetchPromise("/repo/b", "ses_inflight")).toBeDefined()
    expect(await first).toEqual({
      directory: "/repo/a",
      limit: 1,
      complete: false,
      at: 10,
    })
    expect(await duplicate).toEqual({
      directory: "/repo/a",
      limit: 1,
      complete: false,
      at: 10,
    })
    expect(await otherDirectory).toEqual({
      directory: "/repo/b",
      limit: 2,
      complete: true,
      at: 20,
    })
    expect(calls).toBe(2)
    expect(getSessionPrefetchPromise("/repo/a", "ses_inflight")).toBeUndefined()
    expect(getSessionPrefetchPromise("/repo/b", "ses_inflight")).toBeUndefined()
  })

  test("clearing a session invalidates running prefetch revisions", async () => {
    let observed = -1
    const pending = runSessionPrefetch({
      directory: "/repo",
      sessionID: "ses_revision",
      task: async (value) => {
        observed = value
        await Promise.resolve()
        return undefined
      },
    })

    clearSessionPrefetch(["ses_revision"])

    expect(observed).toBe(0)
    expect(isSessionPrefetchCurrent("/repo", "ses_revision", 0)).toBe(false)
    await pending
  })
})
