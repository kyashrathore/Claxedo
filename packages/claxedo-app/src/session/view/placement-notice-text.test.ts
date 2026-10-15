/// <reference types="bun" />
import { expect, test } from "bun:test"
import type { WorkspaceRuntime } from "@/server"
import { sessionScreenEnglishDictionaries } from "./i18n"
import { placementNotice, type PlacementFacts } from "./placement-notice-text"
import type { SessionScreenText } from "./text"

const t = ((key: string, params?: Record<string, unknown>) => [key, ...Object.values(params ?? {})].join(" ")) as SessionScreenText

const facts = (runtime: WorkspaceRuntime, overrides: Partial<PlacementFacts> = {}): PlacementFacts =>
  ({ placement: undefined, name: "main", runtime, wakeProgress: undefined, offline: false, harnessRunsInSessionHost: false, wake: () => undefined, ...overrides })

const noticeFor = (runtime: WorkspaceRuntime) => placementNotice(t, facts(runtime))?.message

test("a workspace's first start says Starting, and a wake of one that ran before says Waking", () => {
  expect(noticeFor({ kind: "waking", bootMode: "cold-start" })).toBe("sessionScreen.workspace.starting main")
  expect(noticeFor({ kind: "waking", followed: true })).toBe("sessionScreen.workspace.starting main")
  expect(noticeFor({ kind: "waking", bootMode: "resume", followed: true })).toBe("sessionScreen.workspace.waking main")
  expect(noticeFor({ kind: "waking" })).toBe("sessionScreen.workspace.waking main")
  expect(noticeFor({ kind: "waking", bootMode: "restore" })).toBe("sessionScreen.workspace.waking main")
})

test("a start refused until a retry time says the reason and when to try again", () => {
  const error = { class: "conflict" as const, message: "the start limit is used up", retryable: false }
  const notice = placementNotice(t, facts({ kind: "wakeFailed", error, retryAt: 1_000_000 }, { retryTime: "15:07" }))
  expect(notice).toMatchObject({ tone: "critical", message: "sessionScreen.workspace.wakeFailed main", detail: "the start limit is used up · sessionScreen.workspace.tryAgainAfter 15:07" })
  const plain = placementNotice(t, facts({ kind: "wakeFailed", error }))
  expect(plain?.detail).toBe("the start limit is used up")
})

test("a sandbox harness on an asleep workspace says a sent message wakes it, with Wake now", () => {
  const wakes: string[] = []
  const notice = placementNotice(t, facts({ kind: "asleep" }, { wake: () => void wakes.push("wake") }))
  expect(notice).toMatchObject({ tone: "info", message: "sessionScreen.workspace.asleep", action: { label: "sessionScreen.workspace.wakeNow" } })
  notice?.action?.run()
  expect(wakes).toEqual(["wake"])
  expect(sessionScreenEnglishDictionaries.en["sessionScreen.workspace.asleep"]).toBe("This workspace is asleep. It wakes when you send a message.")
})

test("a harness that answers from its own session host says nothing about the workspace machine, whatever its state", () => {
  const error = { class: "conflict" as const, message: "the start limit is used up", retryable: false }
  const states: readonly WorkspaceRuntime[] = [{ kind: "asleep" }, { kind: "waking" }, { kind: "waking", bootMode: "cold-start" }, { kind: "wakeFailed", error }, { kind: "outdated" }]
  for (const runtime of states) expect(placementNotice(t, facts(runtime, { harnessRunsInSessionHost: true })), runtime.kind).toBeUndefined()
})

test("a sandbox harness keeps a failed start's own notice", () => {
  const error = { class: "rate_limit" as const, message: "Boat's daily start limit (200) is used up; try again later.", retryable: false }
  expect(placementNotice(t, facts({ kind: "wakeFailed", error }))).toMatchObject({ tone: "critical", message: "sessionScreen.workspace.wakeFailed main", detail: error.message })
})
