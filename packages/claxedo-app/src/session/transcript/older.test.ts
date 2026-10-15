/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createEffect, createRoot, on } from "solid-js"
import { ServerError, type Server } from "@/server"
import { createTranscriptContext } from "./context"
import { loadOlder } from "./older"
import { loadPart } from "./part"
import { readSnapshot } from "./snapshot"
import { transcriptRef, entry, page, turn, shell, withShell, latest, olderPage, firstReadOf, transcriptServer, idle } from "./test-support/transcript-server"

test("older: a page that lands is out of flight before it is announced, so a watcher of the landing can page again at once", async () => {
  const { server, deps, olderReads } = transcriptServer(undefined, [page(turn("msg_1", ["p0", "p9"]), "before-msg-1"), page(turn("msg_0", ["p5", "p6"]))])
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    createEffect(
      on(
        () => context.older.state().kind,
        (kind) => {
          if (kind === "idle" && context.olderCursor() !== undefined) void loadOlder(context)
        },
        { defer: true },
      ),
    )
    await loadOlder(context)
    await idle()
    expect(olderReads).toEqual(["before-the-turn", "before-msg-1"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_0", "msg_0_r", "msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("older: a page that overlaps a turn whose tool body the reader loaded keeps the body", async () => {
  const withHeader = withShell(latest, shell("", true))
  const overlapping = page([...(olderPage.entries as ReturnType<typeof entry>[]), ...(withHeader.entries as ReturnType<typeof entry>[])])
  const { server, deps } = transcriptServer(firstReadOf(withHeader), [overlapping])
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await loadPart(context, "msg_2_r", "p2")
    await loadOlder(context)
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.data.parts["msg_2_r"]?.[0]).toEqual(shell("a\nb"))
    dispose()
  })
})

test("older: a refused page keeps the older cursor, so the reader can page again", async () => {
  const { server: base, deps } = transcriptServer()
  const refused = new ServerError({ class: "network", message: "An older page cannot be read while the session's machine is offline" })
  const server = { ...base, sessions: { ...base.sessions, page: async () => Promise.reject(refused) } } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await loadOlder(context)
    expect(context.older.state()).toMatchObject({ kind: "failed", error: { class: "network" } })
    expect(context.olderCursor()).toBe("before-the-turn")
    dispose()
  })
})
