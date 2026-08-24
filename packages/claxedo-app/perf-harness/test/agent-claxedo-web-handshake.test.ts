import { describe, expect, test } from "bun:test"
import {
  committedRendererEvent,
  createCommittedRendererHandshake,
} from "../src/agent-claxedo-web-handshake"

const url = "http://127.0.0.1:38444/index.local.html"

describe("Claxedo web committed-renderer handshake", () => {
  test("waits for a complete matching event across arbitrary stdout chunks", async () => {
    const handshake = createCommittedRendererHandshake(url)
    let committed = false
    void handshake.committed.then(() => { committed = true })
    const event = committedRendererEvent(url)

    expect(handshake.push(`preview ready\n${event.slice(0, 19)}`)).toEqual(["preview ready"])
    await Promise.resolve()
    expect(committed).toBe(false)

    expect(handshake.push(`${event.slice(19)}\nserver log\n`)).toEqual([event, "server log"])
    await handshake.committed
    expect(committed).toBe(true)
  })

  test("rejects a committed renderer for a different document", async () => {
    const handshake = createCommittedRendererHandshake(url)
    handshake.push(`${committedRendererEvent("http://127.0.0.1:38444/")}\n`)
    await expect(handshake.committed).rejects.toThrow("committed the wrong renderer URL")
  })

  test("rejects a malformed root protocol event instead of treating it as readiness", async () => {
    const handshake = createCommittedRendererHandshake(url)
    handshake.push("__CLAXEDO_WEB_ROOT_EVENT__ not-json\n")
    await expect(handshake.committed).rejects.toThrow("invalid committed-renderer event")
  })

  test("rejects EOF before the root publishes a committed renderer", async () => {
    const handshake = createCommittedRendererHandshake(url)
    handshake.push("preview ready\n")
    expect(handshake.end()).toEqual([])
    await expect(handshake.committed).rejects.toThrow("exited before committing its renderer")
  })
})
