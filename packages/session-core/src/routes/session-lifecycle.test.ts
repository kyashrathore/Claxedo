import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { prepareSessionDelete, settleSessionTurn } from "./session-lifecycle"

describe("session lifecycle hooks", () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  afterEach(() => errors.mockClear())

  test("a settled turn runs every contribution in order, and one that fails is logged without stopping the rest", async () => {
    const ran: string[] = []
    await settleSessionTurn([
      { turnSettled: async (sessionId) => { ran.push(`a:${sessionId}`) } },
      { beforeSessionDelete: async () => { ran.push("never") } },
      { turnSettled: async () => { throw new Error("write-back refused") } },
      { turnSettled: async (sessionId) => { ran.push(`c:${sessionId}`) } },
    ], "ses_1")

    expect(ran).toEqual(["a:ses_1", "c:ses_1"])
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain("ses_1")
  })

  test("a delete stops at the first contribution that fails, before the ones after it", async () => {
    const ran: string[] = []
    await expect(prepareSessionDelete([
      { beforeSessionDelete: async () => { ran.push("a") } },
      { beforeSessionDelete: async () => { throw new Error("not written back") } },
      { beforeSessionDelete: async () => { ran.push("c") } },
    ], "ses_1")).rejects.toThrow("not written back")
    expect(ran).toEqual(["a"])
  })

  test("no contributions is nothing to do", async () => {
    await settleSessionTurn(undefined, "ses_1")
    await prepareSessionDelete([], "ses_1")
    expect(errors).not.toHaveBeenCalled()
  })
})
