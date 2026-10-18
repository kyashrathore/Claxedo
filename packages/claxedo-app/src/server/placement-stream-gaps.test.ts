/// <reference types="bun" />
import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createPlacementStreams } from "./placement-streams"
import { openBody, placement, record, ref, settle, streamTransport, workspaces } from "./test-support/placement-streams"
import type { Workspaces } from "./workspaces"

test("a session stream's first connection re-reads only what it does not cover: a snapshot read taken before the position the stream starts after; a watched workspace stream raises none", async () => {
  const gaps: unknown[] = []
  const transport = streamTransport({ serverUrl: "http://127.0.0.1:1", runtime: async () => openBody("feed_1.8") })
  const watching = { ...workspaces, workspaceStreamRoute: () => record.route } as unknown as Workspaces
  const streams = createPlacementStreams({ transport, workspaces: watching, queryClient: new QueryClient(), onFrame: () => undefined, onGap: (ref) => gaps.push(ref) })
  const { coverage } = streams

  const unwatch = streams.watch(placement)
  await settle()
  expect(gaps).toEqual([])

  const covered = streams.attach(ref("ses_covered"))
  coverage.reading(ref("ses_covered"), "first").landed("feed_1.9")
  await settle()
  expect(gaps, "the stream starts after position 8 and the read is good up to 9: nothing fell between them").toEqual([])

  const stale = streams.attach(ref("ses_stale"))
  coverage.reading(ref("ses_stale"), "first").landed("feed_1.5")
  await settle()
  expect(gaps, "a read good up to 5 misses whatever landed before the stream's 8").toEqual([ref("ses_stale")])

  const unknown = streams.attach(ref("ses_unknown"))
  coverage.reading(ref("ses_unknown"), "first").landed(undefined)
  await settle()
  expect(gaps, "a runtime that answers no position is re-read as before").toEqual([ref("ses_stale"), ref("ses_unknown")])
  covered()
  stale()
  unknown()
  unwatch()
  streams.close()
})

test("a session stream rerouted to the session's own host re-reads the session whatever its reads were good up to", async () => {
  const gaps: unknown[] = []
  const hosted = { ...record.route, sessionHost: { sessionId: "ses_moved" } }
  let route = record.route
  const transport = streamTransport({ serverUrl: "http://127.0.0.1:1", runtime: async () => openBody("feed_1.1") })
  let learned: () => void = () => undefined
  const moving = { ...workspaces, streamRoute: () => route, onSessionHostLearned: (listener: () => void) => { learned = listener; return () => undefined } } as unknown as Workspaces
  const streams = createPlacementStreams({ transport, workspaces: moving, queryClient: new QueryClient(), onFrame: () => undefined, onGap: (ref) => gaps.push(ref) })
  const { coverage } = streams

  const detach = streams.attach(ref("ses_moved"))
  coverage.reading(ref("ses_moved"), "first").landed("feed_1.1")
  await settle()
  expect(gaps).toEqual([])
  route = hosted
  learned()
  await settle()
  expect(gaps).toEqual([ref("ses_moved")])
  detach()
  streams.close()
})
