import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearSessionPrefetch,
  clearSessionPrefetchDirectory,
  getSessionPrefetchPromise,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  sameWorkspaceSessionPrefetchIds,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "./session-prefetch"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "./keys"

describe("session prefetch cache", () => {
  beforeEach(() => {
    queryClient.clear()
  })

  test("stores prefetched message pages in the shell query graph", () => {
    const message = { id: "msg_1", sessionID: "ses_1", role: "user" } as Message
    const part = { id: "part_1", messageID: "msg_1", sessionID: "ses_1", type: "text" } as Part

    setSessionPrefetch({
      directory: "/repo",
      sessionID: "ses_1",
      limit: 1,
      complete: true,
      messages: [message],
      parts: [{ id: "msg_1", part: [part] }],
      at: 10,
    })

    expect(queryClient.getQueryData(shellDataKeys.sessionId("ses_1", "message-prefetch"))).toMatchObject({
      directory: "/repo",
      limit: 1,
      complete: true,
    })
    expect(getSessionPrefetch("ses_1")).toMatchObject({
      limit: 1,
      complete: true,
      messages: [message],
      parts: [{ id: "msg_1", part: [part] }],
      at: 10,
    })
    expect(
      shouldSkipSessionPrefetch({
        message: true,
        info: getSessionPrefetch("ses_1"),
        chunk: 200,
        now: 20,
      }),
    ).toBe(true)

    clearSessionPrefetch(["ses_1"])
    expect(getSessionPrefetch("ses_1")).toBeUndefined()
  })

  test("keys prefetched message pages by session id while keeping directory as cleanup metadata", () => {
    setSessionPrefetch({
      directory: "/repo/a",
      sessionID: "ses_shared",
      limit: 1,
      complete: true,
      at: 10,
    })

    expect(getSessionPrefetch("ses_shared")).toMatchObject({
      directory: "/repo/a",
      limit: 1,
      complete: true,
    })

    clearSessionPrefetchDirectory("/repo/b")
    expect(getSessionPrefetch("ses_shared")).toBeDefined()
    clearSessionPrefetchDirectory("/repo/a")
    expect(getSessionPrefetch("ses_shared")).toBeUndefined()
  })

  test("dedupes inflight prefetch work through Query", async () => {
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
    const second = runSessionPrefetch({
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

    expect(getSessionPrefetchPromise("ses_inflight")).toBeDefined()
    expect(await first).toEqual({
      directory: "/repo/a",
      limit: 1,
      complete: false,
      at: 10,
    })
    expect(await second).toEqual({
      directory: "/repo/a",
      limit: 1,
      complete: false,
      at: 10,
    })
    expect(calls).toBe(1)
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
    expect(isSessionPrefetchCurrent("ses_revision", 0)).toBe(false)
    await pending
  })

  test("prefetches the visible window when the active session is not known yet", () => {
    expect(sameWorkspaceSessionPrefetchIds([{ id: "ses_1" }, { id: "ses_2" }, { id: "ses_3" }], undefined)).toEqual([
      "ses_1",
      "ses_2",
      "ses_3",
    ])
  })

  test("prioritizes adjacent sessions around an active session", () => {
    expect(sameWorkspaceSessionPrefetchIds([{ id: "ses_1" }, { id: "ses_2" }, { id: "ses_3" }], "ses_2")).toEqual([
      "ses_3",
      "ses_1",
    ])
  })

  test("prefetches the same-workspace visible window after adjacent sessions", () => {
    expect(
      sameWorkspaceSessionPrefetchIds(
        [{ id: "ses_1" }, { id: "ses_2" }, { id: "ses_3" }, { id: "ses_4" }, { id: "ses_5" }],
        "ses_3",
      ),
    ).toEqual(["ses_4", "ses_2", "ses_5", "ses_1"])
  })

  test("caps the same-workspace prefetch window", () => {
    expect(
      sameWorkspaceSessionPrefetchIds(
        [{ id: "ses_1" }, { id: "ses_2" }, { id: "ses_3" }, { id: "ses_4" }, { id: "ses_5" }],
        "ses_3",
        2,
      ),
    ).toEqual(["ses_4", "ses_2"])
  })

  test("prefetches the visible window when the active session is not in the loaded slice", () => {
    expect(sameWorkspaceSessionPrefetchIds([{ id: "ses_1" }, { id: "ses_2" }, { id: "ses_3" }], "ses_missing")).toEqual(
      ["ses_1", "ses_2", "ses_3"],
    )
  })
})
