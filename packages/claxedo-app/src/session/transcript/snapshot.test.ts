/// <reference types="bun" />
import { expect, spyOn, test } from "bun:test"
import { createEffect, createRoot, createSignal, on } from "solid-js"
import { ServerError, type Server, type SessionFirstRead } from "@/server"
import { createRequests } from "../requests"
import { createTranscriptContext, type TranscriptDeps } from "./context"
import { loadOlder } from "./older"
import { loadPart } from "./part"
import { readSnapshot } from "./snapshot"
import { createSessionTranscript } from "./store"
import { transcriptRef, shell, withShell, latest, firstReadOf, transcriptServer, idle } from "./test-support/transcript-server"

test("snapshot: a first read lands its row, outline and page in one update, and nothing more is read until the reader pages", async () => {
  const { server, deps, olderReads } = transcriptServer()
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    const seen: string[] = []
    createEffect(
      on(
        () => [context.phase.state().kind, context.data.messages.length, context.outline().kind] as const,
        (state) => seen.push(state.join(" ")),
      ),
    )
    await readSnapshot(context)
    expect(seen, "the row, page and outline land together").toEqual(["loading 0 loading", "ready 2 ready"])
    expect(context.olderCursor()).toBe("before-the-turn")
    await idle()
    expect(olderReads, "an idle transcript reads nothing").toEqual([])

    await loadOlder(context)
    expect(olderReads).toEqual(["before-the-turn"])
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_1", "msg_1_r", "msg_2", "msg_2_r"])
    expect(context.olderCursor()).toBeUndefined()
    dispose()
  })
})

test("snapshot: a reread that sends a tool as its header keeps the body the reader loaded", async () => {
  const withHeader = withShell(latest, shell("", true))
  const { server, deps } = transcriptServer(firstReadOf(withHeader))
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await loadPart(context, "msg_2_r", "p2")
    await readSnapshot(context)
    expect(context.data.parts["msg_2_r"]).toEqual([shell("a\nb"), withHeader.entries[1].parts[1]])
    dispose()
  })
})

test("snapshot: a reread's newer whole part replaces the body the reader loaded", async () => {
  const reads = [withShell(latest, shell("", true)), withShell(latest, shell("a\nb\nc"))]
  const { server: base, deps } = transcriptServer()
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), first: Promise.resolve(firstReadOf(reads.shift()!)) }) } } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await loadPart(context, "msg_2_r", "p2")
    await readSnapshot(context)
    expect(context.data.parts["msg_2_r"]?.[0]).toEqual(shell("a\nb\nc"))
    dispose()
  })
})

test("snapshot: a refused requests read leaves the transcript on screen and names the failure for its Retry, and the next read clears it", async () => {
  const refused = new ServerError({ class: "network", status: 502, code: "harness_engine_error", message: "The engine refused the permission list" })
  const answers = [Promise.reject(refused), Promise.resolve([])]
  const { server: base, deps } = transcriptServer()
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), requests: answers.shift()! }) } } as unknown as Server
  let now = 1_000
  const clock = spyOn(Date, "now").mockImplementation(() => (now += 1))
  await createRoot(async (dispose) => {
    const requests = createRequests(server)
    const context = createTranscriptContext(server, transcriptRef, { ...deps, requests } as unknown as TranscriptDeps)
    await readSnapshot(context)
    await Promise.resolve()
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_2", "msg_2_r"])
    expect(requests.readErrorFor(transcriptRef.sessionId)).toMatchObject({ status: 502, message: "The engine refused the permission list" })
    await readSnapshot(context)
    await Promise.resolve()
    expect(requests.readErrorFor(transcriptRef.sessionId)).toBeUndefined()
    dispose()
  })
  clock.mockRestore()
})

test("snapshot: a missing runtime session keeps the stored transcript and is its own fact, cleared by the next read that finds it", async () => {
  const { server: base, deps } = transcriptServer()
  const failure = new ServerError({ class: "not_found", status: 404, code: "session_not_found", message: "Session not found" })
  let runtime: Promise<undefined> = Promise.reject(failure)
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), runtime, requests: Promise.reject(failure) }) } } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await Promise.allSettled([runtime])
    expect(context.phase.state().kind).toBe("ready")
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_2", "msg_2_r"])
    expect(context.runtimeMissing()).toBe(true)
    runtime = Promise.resolve(undefined)
    await readSnapshot(context)
    await runtime
    expect(context.runtimeMissing()).toBe(false)
    dispose()
  })
})

test("snapshot: a session its runtime no longer had reads again once its workspace is asleep, so the page offers Wake instead of a new session", async () => {
  const { server: base, deps } = transcriptServer()
  const missing = new ServerError({ class: "not_found", status: 404, code: "session_not_found", message: "Session not found" })
  const runtimeReads: Promise<undefined>[] = [Promise.reject(missing)]
  const [reachable, setReachable] = createSignal(true)
  let reads = 0
  let queueReads = 0
  const server = {
    ...base,
    attachPlacement: () => () => undefined,
    placements: { byId: () => ({ kind: "cloud", reachable: reachable() }) },
    sessions: {
      ...base.sessions,
      queue: async () => {
        queueReads += 1
        return []
      },
      read: () => {
        reads += 1
        return { ...base.sessions.read(transcriptRef, deps.pageShape()), runtime: runtimeReads.shift() ?? Promise.resolve(undefined) }
      },
    },
  } as unknown as Server
  await createRoot(async (dispose) => {
    const view = createSessionTranscript(server, transcriptRef, deps)
    await idle()
    expect(view.runtimeMissing()).toBe(true)
    setReachable(false)
    await idle()
    expect([reads, queueReads]).toEqual([2, 2])
    expect(view.runtimeMissing()).toBe(false)
    setReachable(true)
    await idle()
    expect([reads, queueReads], "waking reads nothing here: the stream that reconnects raises its own gap").toEqual([2, 2])
    dispose()
  })
})

test("snapshot: a read asks for the session's queue only once its first read is on the wire", async () => {
  const { server: base, deps } = transcriptServer()
  const sent = Promise.withResolvers<undefined>()
  let queueReads = 0
  const server = {
    ...base,
    sessions: {
      ...base.sessions,
      queue: async () => {
        queueReads += 1
        return []
      },
      read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), firstSent: sent.promise }),
    },
  } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await idle()
    expect(queueReads, "the queue waits for the first read to be sent").toBe(0)
    sent.resolve(undefined)
    await idle()
    expect(queueReads).toBe(1)
    dispose()
  })
})

test("snapshot: a runtime read that fails for another reason is not a missing session", async () => {
  const { server: base, deps } = transcriptServer()
  const runtime = Promise.reject(new ServerError({ class: "network", message: "offline" }))
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), runtime }) } } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    await readSnapshot(context)
    await Promise.allSettled([runtime])
    expect(context.runtimeMissing()).toBe(false)
    dispose()
  })
})

test("snapshot: a gap raised while a read is in flight reads again once it lands, since that read was served before the stream connected", async () => {
  const { server: base, deps } = transcriptServer()
  const landing = Promise.withResolvers<SessionFirstRead>()
  const answers = [landing.promise, Promise.resolve(firstReadOf(withShell(latest, shell("a\nb"))))]
  let reads = 0
  const server = {
    ...base,
    sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), first: answers[reads++] }) },
  } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    const first = readSnapshot(context)
    const again = readSnapshot(context)
    expect(reads, "a gap during a read starts no second request before the first lands").toBe(1)
    landing.resolve(firstReadOf(latest))
    await first
    expect(context.data.parts["msg_2_r"]?.map((part) => part.id)).toEqual(["p3"])
    await again
    expect(reads).toBe(2)
    expect(context.data.parts["msg_2_r"]?.map((part) => part.id), "the re-read lands what the first read missed").toEqual(["p2", "p3"])
    await readSnapshot(context)
    expect(reads, "a settled read coalesces nothing further").toBe(3)
    dispose()
  })
})

test("snapshot: a held return lands its retained turn before its row read answers, and the row read only refreshes the row", async () => {
  const { server: base, deps: baseDeps } = transcriptServer()
  const row = Promise.withResolvers<SessionFirstRead>()
  const rows: string[] = []
  const deps = { ...baseDeps, list: { ...baseDeps.list, readRow: (read: SessionFirstRead["row"]) => void rows.push(read.title ?? "") } } as unknown as TranscriptDeps
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), first: row.promise }) } } as unknown as Server
  await createRoot(async (dispose) => {
    const context = createTranscriptContext(server, transcriptRef, deps)
    const read = readSnapshot(context, { latestTurn: latest, outline: { turns: [], complete: true } })
    expect(context.phase.state().kind, "the retained turn is on screen in the task that opened the session").toBe("ready")
    expect(context.data.messages.map((message) => message.id)).toEqual(["msg_2", "msg_2_r"])
    expect(rows, "the list's own row stands until the read answers").toEqual([])
    row.resolve({ ...firstReadOf(latest), row: { ...firstReadOf(latest).row, title: "Live title" } })
    await read
    await idle()
    expect(rows).toEqual(["Live title"])
    expect(context.data.messages.map((message) => message.id), "the row read lands no page").toEqual(["msg_2", "msg_2_r"])
    dispose()
  })
})

test("snapshot: a held return whose row read fails keeps its retained turn on screen and logs the failure", async () => {
  const { server: base, deps } = transcriptServer()
  const failure = new ServerError({ class: "network", message: "unreachable" })
  const server = { ...base, sessions: { ...base.sessions, read: () => ({ ...base.sessions.read(transcriptRef, deps.pageShape()), first: Promise.reject(failure) }) } } as unknown as Server
  const warn = spyOn(console, "warn").mockImplementation(() => undefined)
  try {
    await createRoot(async (dispose) => {
      const context = createTranscriptContext(server, transcriptRef, deps)
      await readSnapshot(context, { latestTurn: latest, outline: undefined })
      await idle()
      expect(context.phase.state().kind).toBe("ready")
      expect(context.data.messages.map((message) => message.id)).toEqual(["msg_2", "msg_2_r"])
      expect(warn).toHaveBeenCalledWith("A session's row could not be read", expect.objectContaining({ error: expect.objectContaining({ class: "network" }) }))
      dispose()
    })
  } finally {
    warn.mockRestore()
  }
})
