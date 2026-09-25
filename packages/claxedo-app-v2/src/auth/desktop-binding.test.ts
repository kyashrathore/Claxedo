/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
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
    run: async (operation, input) => {
      runs.push({ operation, ...(input ? { input } : {}) })
      if (runFails) throw new Error("Error invoking remote method: HOSTED_HTTP 401 {}")
      return { workspaces: [] }
    },
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

test("desktop account: sign-in follows main's pushed transitions; sign-out returns to signed out", async () => {
  const fake = fakeBridge()
  await createRoot(async (dispose) => {
    const auth = createAuth(desktopAccountBinding(fake.bridge, { signInEnabled: true }))
    fake.answers[0]?.resolve({ status: "unsigned" })
    await settle()
    const signingIn = auth.signIn({ redirectUrl: "ignored" })
    fake.push({ status: "pending" })
    expect(auth.state().kind).toBe("signingIn")
    fake.push(signed)
    fake.answers[1]?.resolve(signed)
    await signingIn
    expect(auth.state().kind).toBe("signedIn")
    const signingOut = auth.signOut()
    fake.answers[2]?.resolve({ status: "unsigned" })
    await signingOut
    expect(auth.state().kind).toBe("signedOut")
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
