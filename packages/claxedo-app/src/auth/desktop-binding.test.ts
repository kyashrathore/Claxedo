/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { desktopAccountBinding } from "./desktop-binding"
import type { DesktopAccountBridge } from "./desktop-bridge"
import { createAuth } from "./store"

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void }

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => undefined
  const promise = new Promise<unknown>((settle) => (resolve = settle))
  return { promise, resolve }
}

function fakeBridge() {
  const answers: Deferred[] = []
  const listeners = new Set<(state: unknown) => void>()
  const runs: { operation: string; input?: Readonly<Record<string, unknown>> }[] = []
  let runFails = false
  const answer = () => {
    const next = deferred()
    answers.push(next)
    return next.promise
  }
  const bridge: DesktopAccountBridge = {
    state: answer,
    onState: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    signIn: answer,
    signOut: answer,
    cancelSignIn: answer,
    run: async (operation, input) => {
      runs.push({ operation, ...(input ? { input } : {}) })
      if (runFails) throw new Error("Error invoking remote method: HOSTED_HTTP 401 {}")
      return { workspaces: [] }
    },
    streamOpen: answer,
    streamStart: answer,
    streamClose: answer,
    onStreamChunk: () => () => undefined,
    onStreamEnd: () => () => undefined,
    onStreamError: () => () => undefined,
  }
  return {
    bridge,
    answers,
    runs,
    push: (state: unknown) => listeners.forEach((listener) => listener(state)),
    failRuns: () => (runFails = true),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const signed = { status: "signed", identity: { userId: "u1", displayName: "Ada" } }

test("desktop account: pending until main answers, then signed with main's identity", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    expect(auth.state().kind).toBe("signingIn")
    fake.answers[0]?.resolve(signed)
    await settle()
    expect(auth.state()).toEqual({ kind: "signedIn", user: { id: "u1", fullName: "Ada" } })
    expect(auth.controlPlane.kind).toBe("port")
    dispose()
  })
})

test("desktop account: a state main pushed wins over an older answer still in flight", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    fake.push({ status: "unsigned" })
    fake.answers[0]?.resolve(signed)
    await settle()
    expect(auth.state().kind).toBe("signedOut")
    dispose()
  })
})

test("desktop account: sign-in and sign-out follow main's pushed transitions, and signing into another account stays signing in until main names it, so no signed-out scope opens in between", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    const seen: string[] = []
    createEffect(() => {
      const state = auth.state()
      const label = state.kind === "signedIn" ? `signedIn:${state.user.id}` : state.kind
      if (seen.at(-1) !== label) seen.push(label)
    })
    fake.answers[0]?.resolve(signed)
    await settle()
    const signingOut = auth.signOut()
    fake.answers[1]?.resolve({ status: "unsigned" })
    await signingOut
    const unnamed = { status: "signed", identity: { userId: "" } }
    const signingIn = auth.signIn()
    fake.push({ status: "pending" })
    fake.push(unnamed)
    fake.answers[2]?.resolve(unnamed)
    await signingIn
    expect(auth.state().kind).toBe("signingIn")
    fake.push({ status: "signed", identity: { userId: "u2", displayName: "Grace" } })
    expect(seen).toEqual(["signingIn", "signedIn:u1", "signedOut", "awaitingBrowser", "signingIn", "signedIn:u2"])
    dispose()
  })
})

test("desktop account: while the browser sign-in waits the reader stays signed out, never signing in, and Cancel ends it as unfinished", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    const seen: string[] = []
    createEffect(() => {
      const kind = auth.state().kind
      if (seen.at(-1) !== kind) seen.push(kind)
    })
    fake.answers[0]?.resolve({ status: "unsigned" })
    await settle()
    const signingIn = auth.signIn()
    fake.push({ status: "pending" })
    expect(auth.state()).toEqual({ kind: "awaitingBrowser" })
    const cancelling = auth.cancelSignIn()
    fake.answers[2]?.resolve({ status: "unsigned", detail: "sign-in cancelled", signInUnfinished: true })
    await cancelling
    fake.answers[1]?.resolve({ status: "unsigned", detail: "sign-in cancelled", signInUnfinished: true })
    await signingIn
    expect(auth.state()).toEqual({ kind: "signInUnfinished" })
    expect(seen).toEqual(["signingIn", "signedOut", "awaitingBrowser", "signInUnfinished"])
    dispose()
  })
})

test("desktop account: a browser sign-in that timed out says it was not finished until the next sign-in starts", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    fake.answers[0]?.resolve({ status: "pending" })
    await settle()
    fake.push({ status: "unsigned", detail: "no callback within 600000ms", signInUnfinished: true })
    expect(auth.state()).toEqual({ kind: "signInUnfinished" })
    void auth.signIn()
    fake.push({ status: "pending" })
    expect(auth.state()).toEqual({ kind: "awaitingBrowser" })
    dispose()
  })
})

test("desktop account: a failed sign-in leaves the reason and keeps sign-in offered as the build allows", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    fake.answers[0]?.resolve({ status: "unavailable", reason: "callback-failed", detail: "The browser never came back" })
    await settle()
    expect(auth.state()).toEqual({ kind: "signedOut", reason: "The browser never came back" })
    expect(auth.offered(false)).toBe(true)
    expect(createAuth(desktopAccountBinding(fakeBridge().bridge, { signInEnabled: false })).offered(true)).toBe(false)
    dispose()
  })
})

test("desktop account: an operation crosses by name, and a rejected one re-reads main's state", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    fake.answers[0]?.resolve(signed)
    await settle()
    if (auth.controlPlane.kind !== "port") throw new Error("the desktop reaches its account through main")
    await auth.controlPlane.run("workspace.list.provisioner")
    expect(fake.runs).toEqual([{ operation: "workspace.list.provisioner" }])
    fake.failRuns()
    const failed = auth.controlPlane.run("workspace.list.machine")
    await settle()
    fake.answers[1]?.resolve({ status: "unsigned" })
    await expect(failed).rejects.toThrow("HOSTED_HTTP 401")
    expect(auth.state().kind).toBe("signedOut")
    dispose()
  })
})

test("desktop account: a session the server rejected ends the signed-in reader as expired, with no unavailability, until the next sign-in starts", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    fake.answers[0]?.resolve(signed)
    await settle()
    fake.push({ status: "unavailable", reason: "revoked", detail: "the server rejected this session" })
    expect(auth.state()).toEqual({ kind: "expired" })
    expect(auth.unavailable()).toBeNull()
    expect(auth.offered(false)).toBe(true)
    void auth.signIn()
    fake.push({ status: "pending" })
    expect(auth.state()).toEqual({ kind: "awaitingBrowser" })
    dispose()
  })
})

test("desktop account: a stored credential the server rejects at launch is expired too, so the reader learns they were signed out", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    fake.answers[0]?.resolve({ status: "unavailable", reason: "revoked", detail: "the server rejected this session" })
    await settle()
    expect(auth.state()).toEqual({ kind: "expired" })
    dispose()
  })
})
