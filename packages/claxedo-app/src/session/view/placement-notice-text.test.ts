/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { WorkspaceRuntime } from "@/server"
import { placementNotice } from "./placement-notice-text"
import type { SessionScreenText } from "./text"

const t = ((key: string, params?: Record<string, unknown>) => [key, ...Object.values(params ?? {})].join(" ")) as SessionScreenText

const noticeFor = (runtime: WorkspaceRuntime) =>
  placementNotice(t, { placement: undefined, name: "main", runtime, wakeProgress: undefined, offline: false, wake: () => undefined })?.message

test("a workspace's first start says Starting, and a wake of one that ran before says Waking", () => {
  expect(noticeFor({ kind: "waking", bootMode: "cold-start" })).toBe("sessionScreen.workspace.starting main")
  expect(noticeFor({ kind: "waking", followed: true })).toBe("sessionScreen.workspace.starting main")
  expect(noticeFor({ kind: "waking", bootMode: "resume", followed: true })).toBe("sessionScreen.workspace.waking main")
  expect(noticeFor({ kind: "waking" })).toBe("sessionScreen.workspace.waking main")
  expect(noticeFor({ kind: "waking", bootMode: "restore" })).toBe("sessionScreen.workspace.waking main")
})

test("a start refused until a retry time says the reason and when to try again", () => {
  const error = { class: "conflict" as const, message: "the start limit is used up", retryable: false }
  const notice = placementNotice(t, { placement: undefined, name: "main", runtime: { kind: "wakeFailed", error, retryAt: 1_000_000 }, wakeProgress: undefined, retryTime: "15:07", offline: false, wake: () => undefined })
  expect(notice).toMatchObject({ tone: "critical", message: "sessionScreen.workspace.wakeFailed main", detail: "the start limit is used up · sessionScreen.workspace.tryAgainAfter 15:07" })
  const plain = placementNotice(t, { placement: undefined, name: "main", runtime: { kind: "wakeFailed", error }, wakeProgress: undefined, offline: false, wake: () => undefined })
  expect(plain?.detail).toBe("the start limit is used up")
})
