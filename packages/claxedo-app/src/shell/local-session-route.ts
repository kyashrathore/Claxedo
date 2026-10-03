import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { machine, unreachable } from "@/lib/machine"
import { toAppError, type AppError, type SessionId, type SessionLocation } from "@/server"

export type LocalSessionResolution =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly sessionId: SessionId }
  | { readonly kind: "ready"; readonly ref: SessionLocation }
  | { readonly kind: "failed"; readonly sessionId: SessionId; readonly error: AppError }

type Event =
  | { readonly type: "cleared" }
  | { readonly type: "requested"; readonly sessionId: SessionId }
  | { readonly type: "resolved"; readonly ref: SessionLocation }
  | { readonly type: "failed"; readonly sessionId: SessionId; readonly error: AppError }

export function transitionLocalSessionResolution(state: LocalSessionResolution, event: Event): LocalSessionResolution {
  switch (event.type) {
    case "cleared": return { kind: "idle" }
    case "requested": return { kind: "loading", sessionId: event.sessionId }
    case "resolved": return state.kind === "loading" && state.sessionId === event.ref.sessionId ? { kind: "ready", ref: event.ref } : state
    case "failed": return state.kind === "loading" && state.sessionId === event.sessionId ? { kind: "failed", sessionId: event.sessionId, error: event.error } : state
    default: return unreachable(event)
  }
}

export function createLocalSessionRoute(
  sessionId: Accessor<SessionId | undefined>,
  resolve: (id: SessionId) => Promise<SessionLocation>,
  known: (id: SessionId) => SessionLocation | undefined,
) {
  const resolution = machine<LocalSessionResolution, Event>({ kind: "idle" }, transitionLocalSessionResolution)
  let activeRequest: object | undefined
  const request = (id: SessionId) => {
    const cached = known(id)
    if (cached) {
      activeRequest = undefined
      resolution.send({ type: "requested", sessionId: id })
      resolution.send({ type: "resolved", ref: cached })
      return
    }
    const token = {}
    activeRequest = token
    resolution.send({ type: "requested", sessionId: id })
    void resolve(id).then((ref) => {
      if (activeRequest === token) resolution.send({ type: "resolved", ref })
    }, (error: unknown) => {
      if (activeRequest === token) resolution.send({ type: "failed", sessionId: id, error: toAppError(error) })
    })
  }
  createEffect(on(sessionId, (id) => {
    activeRequest = undefined
    if (id) request(id)
    else resolution.send({ type: "cleared" })
  }))
  onCleanup(() => { activeRequest = undefined })
  return { state: resolution.state, retry: () => { const id = sessionId(); if (id) request(id) } }
}
