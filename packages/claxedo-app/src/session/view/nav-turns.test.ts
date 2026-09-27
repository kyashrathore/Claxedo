/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { OutlineTurn } from "@/server"
import type { OutlineState } from "@/session"
import type { TranscriptUserMessage } from "@/transcript"
import { navTurns } from "./nav-turns"

const turn = (id: string, title?: string): OutlineTurn => ({ id, createdAt: 1, preview: { user: `prompt ${id}` }, ...(title ? { title } : {}) })
const user = (id: string): TranscriptUserMessage => ({ origin: "optimistic", id, sessionID: "ses_1", role: "user", agent: "build", time: { created: 1 } })
const ready = (turns: OutlineTurn[]): OutlineState => ({ kind: "ready", outline: { turns, complete: true } })

test("nav turns: the outline's turns list ahead of the loaded ones, in id order, and a loaded turn replaces its outline entry", () => {
  const loaded = [user("msg_3"), user("msg_4")]
  const listed = navTurns(ready([turn("msg_1", "First"), turn("msg_2"), turn("msg_3")]), loaded)
  expect(listed.map((item) => item.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
  expect(listed[0]).toEqual({ id: "msg_1", summary: { title: "First" }, preview: { user: "prompt msg_1" } })
  expect(listed[1]).toEqual({ id: "msg_2", preview: { user: "prompt msg_2" } })
  expect(listed[2], "the loaded message, with its own parts for the preview").toBe(loaded[0])
  expect("preview" in listed[2]).toBe(false)
})

test("nav turns: without an outline the rail lists the loaded turns alone", () => {
  for (const state of [{ kind: "loading" }, { kind: "unavailable" }, { kind: "failed", error: { class: "network", message: "offline", retryable: true } }] as const) {
    expect(navTurns(state, [user("msg_3")]).map((item) => item.id)).toEqual(["msg_3"])
  }
})
