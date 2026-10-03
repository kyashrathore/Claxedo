/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { placementId, projectId, ServerError, sessionId, type SessionId, type SessionLocation } from "@/server"
import { createLocalSessionRoute } from "./local-session-route"

const first = { sessionId: sessionId("first"), placementId: placementId("workspace"), projectId: projectId("project") }
const second = { ...first, sessionId: sessionId("second") }

test("local route ignores an obsolete lookup and disposal prevents late resolution", async () => {
  const pending = new Map<SessionId, (ref: SessionLocation) => void>()
  const state = createRoot((dispose) => {
    const [id, setId] = createSignal<SessionId | undefined>(first.sessionId)
    const route = createLocalSessionRoute(id, (requested) => new Promise((resolve) => pending.set(requested, resolve)), () => undefined)
    return { route, setId, dispose }
  })
  expect(state.route.state()).toEqual({ kind: "loading", sessionId: first.sessionId })
  state.setId(second.sessionId)
  pending.get(first.sessionId)!(first)
  await Promise.resolve()
  expect(state.route.state()).toEqual({ kind: "loading", sessionId: second.sessionId })
  state.dispose()
  pending.get(second.sessionId)!(second)
  await Promise.resolve()
  expect(state.route.state().kind).toBe("loading")
})

test("local route exposes a typed failure and explicit retry re-reads canonical identity", async () => {
  let attempts = 0
  const state = createRoot((dispose) => {
    const route = createLocalSessionRoute(() => first.sessionId, async () => {
      if (++attempts === 1) throw new ServerError({ class: "network", message: "Disconnected" })
      return first
    }, () => undefined)
    return { route, dispose }
  })
  await Promise.resolve()
  expect(state.route.state()).toMatchObject({ kind: "failed", error: { class: "network", retryable: true } })
  state.route.retry()
  await Promise.resolve()
  expect(state.route.state()).toEqual({ kind: "ready", ref: first })
  expect(attempts).toBe(2)
  state.dispose()
})

test("a canonical row already held by the list resolves warm navigation synchronously", () => {
  let calls = 0
  const state = createRoot((dispose) => {
    const route = createLocalSessionRoute(() => first.sessionId, async () => { calls += 1; return first }, () => first)
    return { route, dispose }
  })
  expect(state.route.state()).toEqual({ kind: "ready", ref: first })
  expect(calls).toBe(0)
  state.dispose()
})
